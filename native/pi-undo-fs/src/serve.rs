//! 常驻目录扫描服务（`--serve`）。
//!
//! 协议：stdin 逐行 JSON 请求，stdout 逐行 JSON 响应，握手后立即输出 ready 行。
//! 安全模型：常驻缓存只有在 FSEvents 明确无变化时复用；事件异常、缓存漂移或扫描竞争时回退完整重扫。
//! 每次响应前后仍验证 workspace 身份，局部扫描保留目录句柄与父子绑定检查。

use crate::directory::Directory;
use crate::scan_directories::{
    CachedDirectory, Repository, Response, ScanState, load_cache, scan, scan_changed, write_cache,
};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use std::time::{Duration, Instant};

const SERVE_PROTOCOL_VERSION: u32 = 1;
/// 闲置超时：无请求持续该时长后自杀，由调用方按需重启。
/// 空闲 10 秒后退出；客户端按需重新握手并复用持久目录缓存。
const SERVE_IDLE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServeRequest {
    schema_version: u32,
    workspace_root: String,
    /// 可选的持久目录缓存；启动时复用可避免进程重启后的完整重枚举。
    #[serde(default)]
    cache_path: Option<String>,
}

struct EventBatch {
    generation: u64,
    changed_paths: HashSet<String>,
    uncertain: bool,
}

impl EventBatch {
    fn unknown() -> Self {
        Self {
            generation: 0,
            changed_paths: HashSet::new(),
            uncertain: true,
        }
    }
}

struct ResidentState {
    workspace: PathBuf,
    workspace_dev: u64,
    workspace_ino: u64,
    directories: BTreeMap<String, CachedDirectory>,
    watch: Watch,
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

    // 启动监听并清空启动时的目录创建通知；紧随其后的完整扫描覆盖当前树。
    let watch = Watch::create(&workspace).map_err(|error| error.to_string())?;
    let _ = watch.drain(true);
    writeln!(output, r#"{{"ok":true,"ready":true}}"#)
        .map_err(|error| format!("写 serve 握手响应失败：{error}"))?;
    let _ = output.flush();

    // 初始完整扫描建立缓存；失败则整体退出，由调用方回退一次性扫描。
    // 持久缓存只作为起点：scan_inner 仍逐目录核验元数据，漂移会重新枚举。
    let previous_cache = request
        .cache_path
        .as_deref()
        .and_then(|path| load_cache(Path::new(path), &root, &workspace));
    let mut state = ResidentState {
        workspace,
        workspace_dev,
        workspace_ino,
        directories: BTreeMap::new(),
        watch,
    };
    let mut scan_state = ScanState {
        previous: previous_cache.as_ref().map(|cache| &cache.directories),
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
    let initial_events = state.watch.drain(true);
    let (initial_directories, initial_repositories) =
        if initial_events.uncertain || !initial_events.changed_paths.is_empty() {
            let retry = serve_rescan(&mut state, &root)?;
            let after = state.watch.drain(true);
            if after.uncertain || !after.changed_paths.is_empty() {
                return Err("serve 初始扫描期间 workspace 持续发生变化".into());
            }
            (retry.directories, retry.repositories)
        } else {
            (response.directories, response.repositories)
        };
    // 初始扫描结束后写回持久缓存，供下一次进程启动复用；写入失败只是失去预热，不影响服务。
    if let Some(cache_path) = request.cache_path.as_deref() {
        let _ = write_cache(
            Path::new(cache_path),
            &state.workspace,
            &root,
            state.directories.clone(),
        );
    }
    let initial = serde_json::json!({
        "ok": true,
        "directories": initial_directories,
        "cacheHits": false,
        "repositories": initial_repositories,
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
        let pending = state.watch.drain(false);
        let local_generation = pending.generation;
        let result = if pending.uncertain {
            serve_rescan(&mut state, &root)
        } else if pending.changed_paths.is_empty() {
            serve_cached(&state).or_else(|_| serve_rescan(&mut state, &root))
        } else {
            serve_local(&mut state, &root, &pending.changed_paths)
                .or_else(|_| serve_rescan(&mut state, &root))
        };
        let late = state.watch.drain(true);
        let result = if late.uncertain
            || late.generation != local_generation
            || !late.changed_paths.is_empty()
        {
            let retry = if late.uncertain || late.changed_paths.is_empty() {
                serve_rescan(&mut state, &root)
            } else {
                serve_local(&mut state, &root, &late.changed_paths)
                    .or_else(|_| serve_rescan(&mut state, &root))
            };
            if retry.is_ok() {
                let after = state.watch.drain(false);
                if after.uncertain || !after.changed_paths.is_empty() {
                    Err("目录扫描期间 workspace 持续发生变化".into())
                } else {
                    retry
                }
            } else {
                retry
            }
        } else {
            result
        };
        match result {
            Ok(response) => {
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

/// 无事件时只返回已建缓存；workspace 身份仍在每次响应前验证。
fn serve_cached(state: &ResidentState) -> Result<HitResponse, String> {
    assert_workspace_identity(state)?;
    let repositories = state
        .directories
        .iter()
        .filter(|(path, directory)| !path.is_empty() && directory.has_git)
        .map(|(path, directory)| Repository {
            path: path.clone(),
            dev: directory.dev.to_string(),
            ino: directory.ino.to_string(),
        })
        .collect();
    Ok(HitResponse {
        directories: state.directories.len(),
        repositories,
        cache_hits: true,
    })
}

fn serve_local(
    state: &mut ResidentState,
    root: &Directory,
    changed_paths: &HashSet<String>,
) -> Result<HitResponse, String> {
    assert_workspace_identity(state)?;
    let (response, changed_cache, removed, reused) =
        scan_changed(root, changed_paths, &state.directories).map_err(|error| error.to_string())?;
    for removed_path in removed {
        let prefix = format!("{removed_path}/");
        state
            .directories
            .retain(|path, _| path != &removed_path && !path.starts_with(&prefix));
    }
    state.directories.extend(changed_cache);
    assert_workspace_identity(state)?;
    let repositories = state
        .directories
        .iter()
        .filter(|(path, directory)| !path.is_empty() && directory.has_git)
        .map(|(path, directory)| Repository {
            path: path.clone(),
            dev: directory.dev.to_string(),
            ino: directory.ino.to_string(),
        })
        .collect();
    let result = HitResponse {
        directories: state.directories.len(),
        repositories,
        cache_hits: reused > 0 && response.directories == 0,
    };
    Ok(result)
}

fn assert_workspace_identity(state: &ResidentState) -> Result<(), String> {
    let current = fs::symlink_metadata(&state.workspace).map_err(|error| error.to_string())?;
    if !(current.is_dir()
        && current.dev() == state.workspace_dev
        && current.ino() == state.workspace_ino)
    {
        return Err("workspace 身份已变化".into());
    }
    Ok(())
}

struct HitResponse {
    directories: usize,
    repositories: Vec<Repository>,
    cache_hits: bool,
}

/// 失效或不确定时完整枚举目录、重建 cache，并核验扫描期间目录未发生变化。
fn serve_rescan(state: &mut ResidentState, root: &Directory) -> Result<HitResponse, String> {
    assert_workspace_identity(state)?;
    let mut scan_state = ScanState {
        previous: Some(&state.directories),
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
    let result = HitResponse {
        directories: response.directories,
        repositories: response.repositories,
        cache_hits: scan_state.reused_directories == response.directories
            && response.directories > 0,
    };
    let next = std::mem::take(&mut scan_state.next);
    drop(scan_state);
    state.directories = next;
    assert_workspace_identity(state)?;
    Ok(result)
}

#[cfg(target_os = "macos")]
mod watch_impl {
    use super::{EventBatch, HashSet};
    use std::ffi::CString;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFArrayCreate(
            allocator: *const std::ffi::c_void,
            values: *const *const std::ffi::c_void,
            num_values: isize,
            callbacks: *const std::ffi::c_void,
        ) -> *const std::ffi::c_void;
        fn CFArrayGetValueAtIndex(
            array: *const std::ffi::c_void,
            index: isize,
        ) -> *const std::ffi::c_void;
        fn CFStringGetLength(string: *const std::ffi::c_void) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            string: *const std::ffi::c_void,
            buffer: *mut i8,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
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
        fn FSEventStreamFlushSync(stream: *mut std::ffi::c_void);
    }

    #[repr(C)]
    struct FSEventStreamContext {
        version: isize,
        info: *mut std::ffi::c_void,
        retain: *const std::ffi::c_void,
        release: *const std::ffi::c_void,
        copy_description: *const std::ffi::c_void,
    }

    const K_FSEVENTSTREAMUSECFTYPES: u32 = 0x00000001;
    const K_FSEVENTSTREAMNODEFER: u32 = 0x00000002;
    const K_FSEVENTSTREAMIGNORESELF: u32 = 0x00000008;
    const K_FSEVENTSTREAMWATCHROOT: u32 = 0x00000004;
    const K_FSEVENTSTREAMFILEEVENTS: u32 = 0x00000010;
    const K_CFSTRINGENCODING_UTF8: u32 = 0x08000100;
    const EVENT_MUST_SCAN_SUBDIRS: u32 = 0x00000001;
    const EVENT_USER_DROPPED: u32 = 0x00000002;
    const EVENT_KERNEL_DROPPED: u32 = 0x00000004;
    const EVENT_IDS_WRAPPED: u32 = 0x00000008;
    const EVENT_ROOT_CHANGED: u32 = 0x00000020;
    const EVENT_MOUNT: u32 = 0x00000040;
    const EVENT_UNMOUNT: u32 = 0x00000080;
    const EVENT_ITEM_CREATED: u32 = 0x00000100;
    const EVENT_ITEM_REMOVED: u32 = 0x00000200;
    const EVENT_ITEM_RENAMED: u32 = 0x00000800;
    const EVENT_ITEM_IS_FILE: u32 = 0x00010000;
    const EVENT_ITEM_IS_DIR: u32 = 0x00020000;
    const EVENT_ITEM_IS_SYMLINK: u32 = 0x00040000;
    const MAX_CHANGED_PATHS: usize = 8192;

    struct SharedEvents {
        workspace: String,
        pending: Mutex<EventBatch>,
        generation: AtomicU64,
        running: AtomicBool,
    }

    pub(super) struct Watch {
        events: Arc<SharedEvents>,
        stream: *mut std::ffi::c_void,
        run_loop: *mut std::ffi::c_void,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    extern "C" fn on_events(
        _stream: *const std::ffi::c_void,
        info: *mut std::ffi::c_void,
        num_events: usize,
        event_paths: *const std::ffi::c_void,
        event_flags: *const u32,
        _event_ids: *const u64,
    ) {
        if info.is_null() {
            return;
        }
        let events = unsafe { &*(info as *const SharedEvents) };
        let mut pending = match events.pending.lock() {
            Ok(pending) => pending,
            Err(_) => return,
        };
        if num_events == 0 {
            return;
        }
        if num_events > 0 && (event_paths.is_null() || event_flags.is_null()) {
            pending.uncertain = true;
            events.generation.fetch_add(1, Ordering::Release);
            return;
        }
        let paths = event_paths as *const std::ffi::c_void;
        for index in 0..num_events {
            let flags = unsafe { *event_flags.add(index) };
            let value = unsafe { CFArrayGetValueAtIndex(paths, index as isize) };
            let Some(event_path) = cf_string_to_string(value) else {
                pending.uncertain = true;
                continue;
            };
            record_event_path(&mut pending, &events.workspace, &event_path, flags);
        }
        events.generation.fetch_add(1, Ordering::Release);
    }

    fn cf_string_to_string(value: *const std::ffi::c_void) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let length = unsafe { CFStringGetLength(value) };
        let capacity =
            unsafe { CFStringGetMaximumSizeForEncoding(length, K_CFSTRINGENCODING_UTF8) };
        if !(0..=1_048_576).contains(&capacity) {
            return None;
        }
        let mut buffer = vec![0u8; capacity as usize + 1];
        let ok = unsafe {
            CFStringGetCString(
                value,
                buffer.as_mut_ptr() as *mut i8,
                buffer.len() as isize,
                K_CFSTRINGENCODING_UTF8,
            )
        };
        if !ok {
            return None;
        }
        let length = buffer.iter().position(|byte| *byte == 0)?;
        String::from_utf8(buffer[..length].to_vec()).ok()
    }

    fn record_event_path(batch: &mut EventBatch, workspace: &str, path: &str, flags: u32) {
        const LOSS_FLAGS: u32 = EVENT_MUST_SCAN_SUBDIRS
            | EVENT_USER_DROPPED
            | EVENT_KERNEL_DROPPED
            | EVENT_IDS_WRAPPED
            | EVENT_ROOT_CHANGED
            | EVENT_MOUNT
            | EVENT_UNMOUNT;
        if flags & LOSS_FLAGS != 0 {
            batch.uncertain = true;
            return;
        }
        let event_path = std::path::Path::new(path);
        let workspace_path = std::path::Path::new(workspace);
        let Ok(relative) = event_path.strip_prefix(workspace_path) else {
            batch.uncertain = true;
            return;
        };
        let mut components = Vec::new();
        for component in relative.components() {
            match component {
                std::path::Component::Normal(value) => {
                    let Some(value) = value.to_str() else {
                        batch.uncertain = true;
                        return;
                    };
                    components.push(value);
                }
                std::path::Component::CurDir => {}
                _ => {
                    batch.uncertain = true;
                    return;
                }
            }
        }
        let relative_path = components.join("/");
        let is_directory = flags & EVENT_ITEM_IS_DIR != 0;
        let is_file_like = flags & (EVENT_ITEM_IS_FILE | EVENT_ITEM_IS_SYMLINK) != 0;
        if !is_directory && !is_file_like {
            batch.uncertain = true;
            return;
        }
        let parent = std::path::Path::new(&relative_path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .and_then(std::path::Path::to_str)
            .unwrap_or("")
            .to_owned();
        if is_directory {
            insert_changed_path(batch, relative_path.clone());
            if flags & (EVENT_ITEM_CREATED | EVENT_ITEM_REMOVED | EVENT_ITEM_RENAMED) != 0 {
                insert_changed_path(batch, parent);
            }
            return;
        }
        insert_changed_path(batch, parent);
    }

    fn insert_changed_path(batch: &mut EventBatch, path: String) {
        if batch.changed_paths.len() >= MAX_CHANGED_PATHS && !batch.changed_paths.contains(&path) {
            batch.uncertain = true;
            batch.changed_paths.clear();
            return;
        }
        batch.changed_paths.insert(path);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn file_and_directory_events_invalidate_their_parent_chain() {
            let mut batch = EventBatch {
                generation: 0,
                changed_paths: HashSet::new(),
                uncertain: false,
            };
            record_event_path(
                &mut batch,
                "/workspace",
                "/workspace/repo/src/main.rs",
                EVENT_ITEM_IS_FILE,
            );
            record_event_path(
                &mut batch,
                "/workspace",
                "/workspace/repo/new-dir",
                EVENT_ITEM_IS_DIR | EVENT_ITEM_CREATED,
            );
            assert_eq!(
                batch.changed_paths,
                HashSet::from([
                    String::from("repo/src"),
                    String::from("repo"),
                    String::from("repo/new-dir"),
                ])
            );
            assert!(!batch.uncertain);
        }

        #[test]
        fn uncertain_event_batches_force_a_full_rescan() {
            let mut batch = EventBatch {
                generation: 0,
                changed_paths: HashSet::new(),
                uncertain: false,
            };
            record_event_path(
                &mut batch,
                "/workspace",
                "/workspace/repo",
                EVENT_KERNEL_DROPPED,
            );
            assert!(batch.uncertain);

            let mut batch = EventBatch {
                generation: 0,
                changed_paths: HashSet::new(),
                uncertain: false,
            };
            record_event_path(&mut batch, "/workspace", "/outside/repo", EVENT_ITEM_IS_DIR);
            assert!(batch.uncertain);
        }
    }

    impl Watch {
        pub(super) fn create(workspace: &std::path::Path) -> Result<Self, String> {
            let events = Arc::new(SharedEvents {
                workspace: workspace.to_string_lossy().into_owned(),
                pending: Mutex::new(EventBatch {
                    generation: 0,
                    changed_paths: HashSet::new(),
                    uncertain: false,
                }),
                generation: AtomicU64::new(0),
                running: AtomicBool::new(false),
            });
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
                unsafe { CFRelease(cf_path) };
                return Err("CFArray 创建失败".into());
            }
            let mut context = FSEventStreamContext {
                version: 0,
                info: Arc::as_ptr(&events) as *mut std::ffi::c_void,
                retain: std::ptr::null(),
                release: std::ptr::null(),
                copy_description: std::ptr::null(),
            };
            // 延迟设为 10ms，控制交互等待；事件只用于失效，异常状态会完整重扫。
            let stream = unsafe {
                FSEventStreamCreate(
                    std::ptr::null(),
                    on_events,
                    &mut context as *mut FSEventStreamContext as *mut std::ffi::c_void,
                    array,
                    /* since_when */
                    u64::MAX, // kFSEventStreamEventIdSinceNow：只收启动后的新事件
                    /* latency */ 0.01,
                    K_FSEVENTSTREAMUSECFTYPES
                        | K_FSEVENTSTREAMNODEFER
                        | K_FSEVENTSTREAMIGNORESELF
                        | K_FSEVENTSTREAMWATCHROOT
                        | K_FSEVENTSTREAMFILEEVENTS,
                )
            };
            unsafe {
                CFRelease(array);
                CFRelease(cf_path);
            }
            if stream.is_null() {
                return Err("FSEventStream 创建失败".into());
            }
            // 监听跑在独立线程的 RunLoop 上；主线程继续服务 stdin 请求。
            // 通过 channel 把 RunLoop 句柄和启动结果交回主线程，避免启动失败时
            // 主线程永久等待 Barrier，而析构时也能明确停止监听线程。
            let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
            let stream_addr = stream as usize;
            let running_events = Arc::clone(&events);
            let thread = std::thread::spawn(move || {
                let stream = stream_addr as *mut std::ffi::c_void;
                let run_loop = unsafe { CFRunLoopGetCurrent() };
                unsafe {
                    FSEventStreamScheduleWithRunLoop(stream, run_loop, kCFRunLoopDefaultMode);
                    let started = FSEventStreamStart(stream);
                    running_events.running.store(started, Ordering::Release);
                    let _ = started_tx.send((run_loop as usize, started));
                    if !started {
                        return;
                    }
                    CFRunLoopRun();
                    running_events.running.store(false, Ordering::Release);
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
                events,
                stream,
                run_loop: run_loop_addr as *mut std::ffi::c_void,
                thread: Some(thread),
            })
        }

        pub(super) fn drain(&self, settle: bool) -> EventBatch {
            if settle {
                std::thread::sleep(std::time::Duration::from_millis(12));
            }
            if !self.events.running.load(Ordering::Acquire) {
                return EventBatch::unknown();
            }
            unsafe { FSEventStreamFlushSync(self.stream) };
            if !self.events.running.load(Ordering::Acquire) {
                return EventBatch::unknown();
            }
            let generation = self.events.generation.load(Ordering::Acquire);
            let mut pending = match self.events.pending.lock() {
                Ok(pending) => pending,
                Err(_) => return EventBatch::unknown(),
            };
            let changed_paths = std::mem::take(&mut pending.changed_paths);
            let uncertain = std::mem::replace(&mut pending.uncertain, false);
            EventBatch {
                generation,
                changed_paths,
                uncertain,
            }
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
    use super::EventBatch;

    // 非 macOS 平台暂不提供常驻模式：--serve 直接返回不支持。
    pub(super) struct Watch;
    impl Watch {
        pub(super) fn create(_workspace: &std::path::Path) -> Result<Self, String> {
            Err("当前平台不支持常驻扫描".into())
        }
        pub(super) fn drain(&self, _settle: bool) -> EventBatch {
            EventBatch::unknown()
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
