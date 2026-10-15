//! 常驻目录扫描服务（`--serve`）。
//!
//! 协议：stdin 逐行 JSON 请求，stdout 逐行 JSON 响应，握手后立即输出 ready 行。
//! 安全模型：FSEvents 只作为"可能变化"的失效触发器，绝不作为正确性证据。
//! - 无事件且缓存完整：逐目录 fstat 校验（无 readdir），任何不匹配立即失败。
//! - 有事件/溢出/失败：回退现有增量扫描路径，语义与一次性扫描一致。
//! - 每次响应前后 workspace dev/ino 校验保留，fail-closed 不变。

use crate::directory::Directory;
use crate::scan_directories::{
    metadata_matches, scan, DirectoryCache, Repository, Response, ScanState, CACHE_SCHEMA_VERSION,
    WATCH_TREE_MAX_DEPTH,
};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use std::time::{Duration, Instant};

const SERVE_PROTOCOL_VERSION: u32 = 1;
/// 闲置超时：无请求持续该时长后自杀，由调用方按需重启。
const SERVE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServeRequest {
    schema_version: u32,
    workspace_root: String,
}

struct ResidentState {
    workspace: PathBuf,
    workspace_dev: u64,
    workspace_ino: u64,
    directories: BTreeMap<String, crate::scan_directories::CachedDirectory>,
    watch: Watch,
    dirty: bool,
    overflow: bool,
}

fn main_loop(
    mut input: BufReader<impl std::io::Read>,
    mut output: impl std::io::Write,
) -> Result<(), String> {
    // 闲置自杀看门狗：无请求持续 SERVE_IDLE_TIMEOUT 后进程退出，由调用方按需重启。
    // busy 标志在请求处理期间置 1，处理结束归 0；扫描长操作不受影响（最长操作时间远小于超时也成立：
    // 看门狗只看 busy，不看总时长）。
    let busy = Arc::new(AtomicBool::new(true));
    {
        let busy_flag = busy.clone();
        std::thread::spawn(move || {
            let mut idle_start: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                if busy_flag.load(Ordering::Relaxed) {
                    idle_start = None;
                } else {
                    let since = *idle_start.get_or_insert_with(Instant::now);
                    if since.elapsed() >= SERVE_IDLE_TIMEOUT {
                        std::process::exit(0);
                    }
                }
            }
        });
    }
    let mut line = String::new();
    input
        .read_line(&mut line)
        .map_err(|error| format!("读取 serve 握手失败：{error}"))?;
    let request: ServeRequest = serde_json::from_str(line.trim())
        .map_err(|error| format!("解析 serve 握手失败：{error}"))?;
    if request.schema_version != SERVE_PROTOCOL_VERSION {
        return Err("serve 协议版本不受支持".into());
    }
    let workspace = PathBuf::from(&request.workspace_root);
    if fs::canonicalize(&workspace).map_err(|error| error.to_string())? != workspace {
        return Err("workspaceRoot 必须是 canonical path".into());
    }
    let root = Directory::open(&workspace).map_err(|error| error.to_string())?;
    let stamp = root.file.metadata().map_err(|error| error.to_string())?;
    let workspace_dev = stamp.dev();
    let workspace_ino = stamp.ino();

    // 握手确认后启动监听：启动前的窗口由首次完整扫描覆盖。
    let watch = Watch::create(&workspace).map_err(|error| error.to_string())?;
    writeln!(output, r#"{{"ok":true,"ready":true}}"#)
        .map_err(|error| format!("写 serve 握手响应失败：{error}"))?;
    let _ = output.flush();

    // 初始完整扫描建立缓存；失败则整体退出，由调用方回退一次性扫描。
    let mut state = ResidentState {
        workspace,
        workspace_dev,
        workspace_ino,
        directories: BTreeMap::new(),
        watch,
        dirty: false,
        overflow: false,
    };
    let mut scan_state = ScanState {
        previous: None,
        next: BTreeMap::new(),
        reused_directories: 0,
    };
    let mut response = Response {
        ok: true,
        directories: 0,
        repositories: Vec::new(),
    };
    scan(&root, "", 0, &mut response, &mut scan_state)
        .map_err(|error| format!("serve 初始扫描失败：{error}"))?;
    state.directories = scan_state.next;
    let initial = serde_json::json!({
        "ok": true,
        "directories": response.directories,
        "cacheHits": false,
        "repositories": response.repositories,
    });
    writeln!(output, "{initial}").map_err(|error| format!("写 serve 响应失败：{error}"))?;
    output
        .flush()
        .map_err(|error| format!("flush 失败：{error}"))?;

    loop {
        busy.store(false, Ordering::Relaxed);
        let mut line = Vec::new();
        let read = input
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("读取 serve 请求失败：{error}"))?;
        if read == 0 {
            return Ok(()); // 客户端关闭：进程随之退出。
        }
        busy.store(true, Ordering::Relaxed);
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.is_empty() {
            busy.store(false, Ordering::Relaxed);
            continue;
        }
        let _request: ScanRequest = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(error) => {
                write_error(&mut output, &format!("解析 scan 请求失败：{error}"))?;
                busy.store(false, Ordering::Relaxed);
                continue;
            }
        };
        // 事件在请求间隙持续累积；drain 把累积状态转为本次响应的失效依据。
        if let Some((dirty, overflow)) = state.watch.drain() {
            state.dirty = state.dirty || dirty;
            state.overflow = state.overflow || overflow;
        }
        let result = if !state.dirty && !state.overflow {
            serve_cache_hit(&mut state, &root)
        } else {
            serve_rescan(&mut state, &root)
        };
        match result {
            Ok(response) => {
                // 成功后清空失效状态：本次响应已包含最新拓扑。
                state.dirty = false;
                state.overflow = false;
                let payload = serde_json::json!({
                    "ok": true,
                    "directories": response.directories,
                    "cacheHits": response.cache_hits,
                    "repositories": response.repositories,
                });
                writeln!(output, "{payload}")
                    .map_err(|error| format!("写 serve 响应失败：{error}"))?;
            }
            Err(error) => write_error(&mut output, &error)?,
        }
        output
            .flush()
            .map_err(|error| format!("写 serve 响应失败：{error}"))?;
        busy.store(false, Ordering::Relaxed);
    }
}

fn write_error(output: &mut impl std::io::Write, error: &str) -> Result<(), String> {
    let payload = serde_json::json!({ "ok": false, "error": error });
    writeln!(output, "{payload}").map_err(|error| format!("写 serve 错误响应失败：{error}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScanRequest {
    #[allow(dead_code)]
    schema_version: u32,
}

/// 缓存命中路径：逐目录打开 + fstat 校验身份/时间戳，不做 readdir。
/// 树结构与缓存 children 完全一致才成功；任何偏差返回 Err，调用方回退重扫。
fn serve_cache_hit(state: &mut ResidentState, root: &Directory) -> Result<HitResponse, String> {
    let current = fs::symlink_metadata(&state.workspace).map_err(|error| error.to_string())?;
    if !(current.is_dir()
        && current.dev() == state.workspace_dev
        && current.ino() == state.workspace_ino)
    {
        return Err("workspace 身份已变化".into());
    }
    let mut response = HitResponse {
        directories: 0,
        repositories: Vec::new(),
        cache_hits: true,
    };
    verify_tree(root, "", 0, state, &mut response)?;
    Ok(response)
}

fn verify_tree(
    directory: &Directory,
    path: &str,
    depth: usize,
    state: &mut ResidentState,
    response: &mut HitResponse,
) -> Result<(), String> {
    if depth > WATCH_TREE_MAX_DEPTH {
        return Err("目录深度超过限制".into());
    }
    let Some(cached) = state.directories.get(path).cloned() else {
        return Err(format!("缓存缺少目录：{path}"));
    };
    let metadata = directory
        .file
        .metadata()
        .map_err(|error| error.to_string())?;
    if !metadata_matches(&cached, &metadata) {
        return Err(format!("目录与缓存不匹配：{path}"));
    }
    response.directories += 1;
    if !path.is_empty() && cached.has_git {
        response.repositories.push(Repository {
            path: path.into(),
            dev: metadata.dev().to_string(),
            ino: metadata.ino().to_string(),
        });
    }
    for name in &cached.children {
        let child = directory
            .open_child(std::ffi::OsStr::new(name))
            .map_err(|error| format!("打开子目录失败 {path}/{name}：{error}"))?;
        let child_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        verify_tree(&child, &child_path, depth + 1, state, response)?;
        directory
            .assert_child(std::ffi::OsStr::new(name), &child)
            .map_err(|error| format!("子目录身份变化 {path}/{name}：{error}"))?;
    }
    Ok(())
}

struct HitResponse {
    directories: usize,
    repositories: Vec<Repository>,
    cache_hits: bool,
}

/// 失效路径：以当前缓存为 previous 走增量扫描（目录级 metadata 校验 + 重建缓存）。
fn serve_rescan(state: &mut ResidentState, root: &Directory) -> Result<HitResponse, String> {
    let current = fs::symlink_metadata(&state.workspace).map_err(|error| error.to_string())?;
    if !(current.is_dir()
        && current.dev() == state.workspace_dev
        && current.ino() == state.workspace_ino)
    {
        return Err("workspace 身份已变化".into());
    }
    let cache = DirectoryCache {
        schema_version: CACHE_SCHEMA_VERSION,
        workspace_root: state.workspace.to_string_lossy().into_owned(),
        workspace_dev: state.workspace_dev,
        workspace_ino: state.workspace_ino,
        directories: std::mem::take(&mut state.directories),
    };
    let mut scan_state = ScanState {
        previous: Some(&cache),
        next: BTreeMap::new(),
        reused_directories: 0,
    };
    let mut response = Response {
        ok: true,
        directories: 0,
        repositories: Vec::new(),
    };
    scan(root, "", 0, &mut response, &mut scan_state)
        .map_err(|error| format!("serve 增量扫描失败：{error}"))?;
    state.directories = scan_state.next;
    Ok(HitResponse {
        directories: response.directories,
        repositories: response.repositories,
        cache_hits: scan_state.reused_directories == response.directories
            && response.directories > 0,
    })
}

#[cfg(target_os = "macos")]
mod watch_impl {
    use std::ffi::CString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFArrayCreate(
            allocator: *const std::ffi::c_void,
            values: *const *const std::ffi::c_void,
            num_values: isize,
            callbacks: *const std::ffi::c_void,
        ) -> *const std::ffi::c_void;
        fn CFRunLoopGetCurrent() -> *mut std::ffi::c_void;
        fn CFRunLoopRun();
        fn CFRunLoopStop(run_loop: *mut std::ffi::c_void);
        fn CFStringCreateWithCString(
            allocator: *const std::ffi::c_void,
            c_str: *const i8,
            encoding: u32,
        ) -> *const std::ffi::c_void;
        fn CFRelease(value: *const std::ffi::c_void);
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
    }

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn FSEventStreamCreate(
            allocator: *const std::ffi::c_void,
            callback: extern "C" fn(
                *const std::ffi::c_void,
                *mut std::ffi::c_void,
                usize,
                *const std::ffi::c_void,
                *const u32,
                *const u64,
            ),
            context: *mut std::ffi::c_void,
            paths: *const std::ffi::c_void,
            since_when: u64,
            latency: f64,
            flags: u32,
        ) -> *mut std::ffi::c_void;
        fn FSEventStreamScheduleWithRunLoop(
            stream: *mut std::ffi::c_void,
            run_loop: *mut std::ffi::c_void,
            mode: *const std::ffi::c_void,
        );
        fn FSEventStreamStart(stream: *mut std::ffi::c_void) -> bool;
        fn FSEventStreamStop(stream: *mut std::ffi::c_void);
        fn FSEventStreamInvalidate(stream: *mut std::ffi::c_void);
        fn FSEventStreamRelease(stream: *mut std::ffi::c_void);
    }

    #[repr(C)]
    struct FSEventStreamContext {
        version: isize,
        info: *mut std::ffi::c_void,
        retain: *const std::ffi::c_void,
        release: *const std::ffi::c_void,
        copy_description: *const std::ffi::c_void,
    }

    const K_FSEVENTSTREAMCREATENOFLAGS: u32 = 0x00000000;
    const K_FSEVENTSTREAMIGNORESELF: u32 = 0x00000008;
    const K_CFSTRINGENCODING_UTF8: u32 = 0x08000100;

    pub(super) struct Watch {
        dirty: Arc<AtomicBool>,
        stream: *mut std::ffi::c_void,
        run_loop: *mut std::ffi::c_void,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    extern "C" fn on_events(
        _stream: *const std::ffi::c_void,
        info: *mut std::ffi::c_void,
        _num_events: usize,
        _event_paths: *const std::ffi::c_void,
        _event_flags: *const u32,
        _event_ids: *const u64,
    ) {
        if info.is_null() {
            return;
        }
        let dirty = unsafe { &*(info as *const AtomicBool) };
        // 历史事件或溢出都置脏：无需区分路径。
        dirty.store(true, Ordering::SeqCst);
    }

    impl Watch {
        pub(super) fn create(workspace: &std::path::Path) -> Result<Self, String> {
            let dirty = Arc::new(AtomicBool::new(false));
            let path_c = CString::new(workspace.to_str().ok_or("workspace 路径不是 UTF-8")?)
                .map_err(|_| "workspace 路径含 NUL")?;
            let cf_path = unsafe {
                CFStringCreateWithCString(
                    std::ptr::null(),
                    path_c.as_ptr(),
                    K_CFSTRINGENCODING_UTF8,
                )
            };
            if cf_path.is_null() {
                return Err("CFString 创建失败".into());
            }
            let paths = [cf_path];
            let array = unsafe {
                CFArrayCreate(
                    std::ptr::null(),
                    paths.as_ptr() as *const _,
                    1,
                    std::ptr::null(),
                )
            };
            if array.is_null() {
                return Err("CFArray 创建失败".into());
            }
            let mut context = FSEventStreamContext {
                version: 0,
                info: Arc::as_ptr(&dirty) as *mut std::ffi::c_void,
                retain: std::ptr::null(),
                release: std::ptr::null(),
                copy_description: std::ptr::null(),
            };
            // 延迟 0：事件尽快送达；延迟只影响批量，不影响正确性（事件只用于失效）。
            let stream = unsafe {
                FSEventStreamCreate(
                    std::ptr::null(),
                    on_events,
                    &mut context as *mut FSEventStreamContext as *mut std::ffi::c_void,
                    array,
                    /* since_when */
                    u64::MAX, // kFSEventStreamEventIdSinceNow：只收启动后的新事件
                    /* latency */ 0.1,
                    K_FSEVENTSTREAMIGNORESELF | K_FSEVENTSTREAMCREATENOFLAGS,
                )
            };
            unsafe { CFRelease(array) };
            if stream.is_null() {
                return Err("FSEventStream 创建失败".into());
            }
            // 监听跑在独立线程的 RunLoop 上；主线程继续服务 stdin 请求。
            // 通过 channel 把 RunLoop 句柄和启动结果交回主线程，避免启动失败时
            // 主线程永久等待 Barrier，而析构时也能明确停止监听线程。
            let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
            let stream_addr = stream as usize;
            let thread = std::thread::spawn(move || {
                let stream = stream_addr as *mut std::ffi::c_void;
                let run_loop = unsafe { CFRunLoopGetCurrent() };
                unsafe {
                    FSEventStreamScheduleWithRunLoop(stream, run_loop, kCFRunLoopDefaultMode);
                    let started = FSEventStreamStart(stream);
                    let _ = started_tx.send((run_loop as usize, started));
                    if !started {
                        return;
                    }
                    CFRunLoopRun();
                }
            });
            let (run_loop_addr, started) = match started_rx.recv() {
                Ok(value) => value,
                Err(_) => {
                    unsafe {
                        FSEventStreamInvalidate(stream);
                        FSEventStreamRelease(stream);
                    }
                    let _ = thread.join();
                    return Err("FSEventStream 启动线程失败".into());
                }
            };
            if !started {
                unsafe {
                    FSEventStreamInvalidate(stream);
                    FSEventStreamRelease(stream);
                }
                let _ = thread.join();
                return Err("FSEventStream 启动失败".into());
            }
            Ok(Self {
                dirty,
                stream,
                run_loop: run_loop_addr as *mut std::ffi::c_void,
                thread: Some(thread),
            })
        }

        /// 返回 (dirty, overflow)；FSEvents 无独立溢出标志，历史事件一并置脏。
        pub(super) fn drain(&mut self) -> Option<(bool, bool)> {
            let dirty = self.dirty.swap(false, Ordering::SeqCst);
            Some((dirty, false))
        }
    }

    impl Drop for Watch {
        fn drop(&mut self) {
            unsafe {
                // 监听线程阻塞在 CFRunLoopRun；仅停止 stream 不会唤醒它，
                // 必须先停止 RunLoop，否则后续 join 会永久等待。
                CFRunLoopStop(self.run_loop);
                FSEventStreamStop(self.stream);
                FSEventStreamInvalidate(self.stream);
                FSEventStreamRelease(self.stream);
            }
            if let Some(thread) = self.thread.take() {
                thread.join().ok();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod watch_impl {
    // 非 macOS 平台暂不提供常驻模式：--serve 直接返回不支持。
    pub(super) struct Watch;
    impl Watch {
        pub(super) fn create(_workspace: &std::path::Path) -> Result<Self, String> {
            Err("当前平台不支持常驻扫描".into())
        }
        pub(super) fn drain(&mut self) -> Option<(bool, bool)> {
            None
        }
    }
}
use watch_impl::Watch;

pub(crate) fn run(
    input: impl std::io::Read + Send + 'static,
    output: impl std::io::Write + Send + 'static,
) -> Result<(), String> {
    main_loop(BufReader::new(input), output)
}
