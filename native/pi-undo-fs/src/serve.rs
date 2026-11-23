//! 常驻目录扫描服务（`--serve`）。
//!
//! 协议：stdin 逐行 JSON 请求，stdout 逐行 JSON 响应，握手后立即输出 ready 行。
//! 安全模型：常驻缓存只有在 FSEvents（macOS）或 inotify（Linux）明确无变化时复用；事件异常、缓存漂移或扫描竞争时回退完整重扫。
//! 每次响应前后仍验证 workspace 身份，局部扫描保留目录句柄与父子绑定检查。

use crate::directory::Directory;
use crate::scan_directories::{
    CachedDirectory, Repository, Response, ScanState, collect_leaves, load_cache,
    scan, scan_changed, verify_leaf_subtree, write_cache,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use std::time::{Duration, Instant};

const SERVE_PROTOCOL_VERSION: u32 = 1;
/// 闲置超时：无请求持续该时长后自杀，由调用方按需重启。
/// 空闲 10 秒后退出；客户端按需重新握手并复用持久目录缓存。
const SERVE_IDLE_TIMEOUT: Duration = Duration::from_secs(10);
/// 单次 drain 最多保留的精确变更项；超限时要求调用方退回完整捕获。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_CHANGED_ENTRIES: usize = 8192;
/// 变更日志最多保存的路径数；超出后丢弃最早一半，并拒绝越过该序号的查询。
const MAX_TRACKED_CHANGE_PATHS: usize = 65_536;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServeRequest {
    schema_version: u32,
    workspace_root: String,
    /// 可选的持久目录缓存；启动时复用可避免进程重启后的完整重枚举。
    #[serde(default)]
    cache_path: Option<String>,
}

#[derive(Clone)]
struct EventBatch {
    generation: u64,
    changed_paths: HashSet<String>,
    /// 精确到文件/符号链接的变化项，供结算前的快速变更探测使用。
    changed_files: HashSet<String>,
    /// 精确到目录的变化项；目录结构变化需要按子树捕获。
    changed_dirs: HashSet<String>,
    uncertain: bool,
    /// 仅普通文件目录项或明确的目录元数据事件，允许核验后复用无事件的近期子树。
    file_entries_only: bool,
    /// 本次进程的监听从未丢失事件；只有此时才允许不看时间戳窗口复用子树。
    coverage_trusted: bool,
}

impl EventBatch {
    fn unknown() -> Self {
        Self {
            generation: 0,
            changed_paths: HashSet::new(),
            changed_files: HashSet::new(),
            changed_dirs: HashSet::new(),
            uncertain: true,
            file_entries_only: false,
            coverage_trusted: false,
        }
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn record_file(&mut self, path: String) {
        self.record_change(true, path);
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn record_dir(&mut self, path: String) {
        self.record_change(false, path);
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn record_change(&mut self, file: bool, path: String) {
        if path.is_empty() || is_git_metadata_path(&path) {
            // 根目录事件无法用路径 scope 表达；.git 不属于快照内容。
            if path.is_empty() {
                self.uncertain = true;
                self.coverage_trusted = false;
            }
            return;
        }
        let set = if file { &mut self.changed_files } else { &mut self.changed_dirs };
        if set.len() >= MAX_CHANGED_ENTRIES && !set.contains(&path) {
            self.uncertain = true;
            self.coverage_trusted = false;
            self.changed_files.clear();
            self.changed_dirs.clear();
            return;
        }
        set.insert(path);
    }
}

/// 只记录路径的最新变化序号；查询时返回序号晚于 since 的路径。
struct ChangeTracker {
    sequence: u64,
    files: HashMap<String, u64>,
    dirs: HashMap<String, u64>,
    pruned_before: u64,
    trusted: bool,
}

impl ChangeTracker {
    fn new() -> Self {
        Self {
            sequence: 0,
            files: HashMap::new(),
            dirs: HashMap::new(),
            pruned_before: 0,
            trusted: true,
        }
    }

    fn record(&mut self, batch: &EventBatch) {
        if batch.uncertain || !batch.coverage_trusted {
            self.trusted = false;
        }
        if batch.changed_files.is_empty() && batch.changed_dirs.is_empty() {
            return;
        }
        self.sequence = self.sequence.saturating_add(1);
        let sequence = self.sequence;
        for path in &batch.changed_files {
            self.files.insert(path.clone(), sequence);
        }
        for path in &batch.changed_dirs {
            self.dirs.insert(path.clone(), sequence);
        }
        self.prune();
    }

    fn prune(&mut self) {
        if self.files.len() + self.dirs.len() <= MAX_TRACKED_CHANGE_PATHS {
            return;
        }
        let mut sequences: Vec<u64> = self.files.values().chain(self.dirs.values()).copied().collect();
        sequences.sort_unstable();
        let cutoff = sequences[sequences.len() / 2];
        self.files.retain(|_, sequence| *sequence > cutoff);
        self.dirs.retain(|_, sequence| *sequence > cutoff);
        self.pruned_before = self.pruned_before.max(cutoff);
    }

    fn changes_since(&self, since: u64) -> (Vec<String>, Vec<String>, bool) {
        if !self.trusted || since > self.sequence || since < self.pruned_before {
            return (Vec::new(), Vec::new(), false);
        }
        let mut files: Vec<String> = self.files.iter()
            .filter(|(_, sequence)| **sequence > since)
            .map(|(path, _)| path.clone())
            .collect();
        let mut dirs: Vec<String> = self.dirs.iter()
            .filter(|(_, sequence)| **sequence > since)
            .map(|(path, _)| path.clone())
            .collect();
        files.sort();
        dirs.sort();
        (files, dirs, true)
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_git_metadata_path(path: &str) -> bool {
    path.split('/').any(|component| component.eq_ignore_ascii_case(".git"))
}

#[cfg(test)]
mod change_tracker_tests {
    use super::*;

    fn batch(files: &[&str], dirs: &[&str]) -> EventBatch {
        let mut batch = EventBatch::unknown();
        batch.uncertain = false;
        batch.coverage_trusted = true;
        for file in files {
            batch.record_file((*file).to_owned());
        }
        for dir in dirs {
            batch.record_dir((*dir).to_owned());
        }
        batch
    }

    #[test]
    fn changes_since_only_returns_entries_after_the_requested_sequence() {
        let mut tracker = ChangeTracker::new();
        tracker.record(&batch(&["src/a.ts"], &[]));
        let (files, dirs, trusted) = tracker.changes_since(0);
        assert!(trusted);
        assert_eq!(files, vec!["src/a.ts".to_owned()]);
        assert!(dirs.is_empty());

        let (files, _, trusted) = tracker.changes_since(1);
        assert!(trusted);
        assert!(files.is_empty());

        tracker.record(&batch(&["src/b.ts"], &["new-dir"]));
        let (files, dirs, trusted) = tracker.changes_since(1);
        assert!(trusted);
        assert_eq!(files, vec!["src/b.ts".to_owned()]);
        assert_eq!(dirs, vec!["new-dir".to_owned()]);
    }

    #[test]
    fn untrusted_or_future_sequences_refuse_the_fast_path() {
        let mut tracker = ChangeTracker::new();
        tracker.record(&batch(&["src/a.ts"], &[]));
        let mut uncertain = batch(&["src/b.ts"], &[]);
        uncertain.uncertain = true;
        tracker.record(&uncertain);
        assert!(!tracker.changes_since(0).2);
        assert!(!ChangeTracker::new().changes_since(1).2);
    }

    #[test]
    fn git_metadata_is_not_part_of_the_workspace_change_set() {
        let mut batch = EventBatch::unknown();
        batch.uncertain = false;
        batch.coverage_trusted = true;
        batch.record_file(".git/index".into());
        batch.record_file("packages/.git/HEAD".into());
        batch.record_dir(".git/objects".into());
        assert!(batch.changed_files.is_empty());
        assert!(batch.changed_dirs.is_empty());
        assert!(!batch.uncertain);
    }
}

struct ResidentState {
    workspace: PathBuf,
    workspace_dev: u64,
    workspace_ino: u64,
    directories: BTreeMap<String, CachedDirectory>,
    changes: ChangeTracker,
    /// 本次 helper 进程的唯一标识；序号只在本实例内可比较。
    change_instance: String,
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
    // busy 只在请求处理期间为 true，极短的 keepAlive 请求可能落在两次采样之间；
    // 额外记录请求到达次数，确保任何请求都能重置看门狗。
    let activity = Arc::new(AtomicU64::new(0));
    {
        let busy_flag = busy.clone();
        let activity_flag = activity.clone();
        std::thread::spawn(move || {
            let mut idle_start: Option<Instant> = None;
            let mut observed_activity = activity_flag.load(Ordering::Relaxed);
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let current_activity = activity_flag.load(Ordering::Relaxed);
                if busy_flag.load(Ordering::Relaxed) || current_activity != observed_activity {
                    observed_activity = current_activity;
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
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut state = ResidentState {
        workspace,
        workspace_dev,
        workspace_ino,
        directories: BTreeMap::new(),
        changes: ChangeTracker::new(),
        change_instance: format!("{}-{started_at}", std::process::id()),
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
        "changeSeq": state.changes.sequence,
        "changeInstance": state.change_instance,
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
        activity.fetch_add(1, Ordering::Relaxed);
        busy.store(true, Ordering::Relaxed);
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.is_empty() {
            busy.store(false, Ordering::Relaxed);
            continue;
        }
        let request: ScanRequest = match serde_json::from_slice(&line) {
            Ok(request) => request,
            Err(error) => {
                write_error(&mut output, &format!("解析 scan 请求失败：{error}"))?;
                busy.store(false, Ordering::Relaxed);
                continue;
            }
        };
        if request.schema_version != SERVE_PROTOCOL_VERSION {
            write_error(&mut output, "scan 协议版本不受支持")?;
            output.flush().map_err(|error| error.to_string())?;
            continue;
        }
        if request.keep_alive {
            let payload = serde_json::json!({
                "ok": true,
                "changeSeq": state.changes.sequence,
            });
            writeln!(output, "{payload}")
                .map_err(|error| format!("写 serve 响应失败：{error}"))?;
            output.flush().map_err(|error| error.to_string())?;
            busy.store(false, Ordering::Relaxed);
            continue;
        }
        if let Some(since) = request.since_seq {
            if let Err(error) = assert_workspace_identity(&state) {
                write_error(&mut output, &error)?;
                output.flush().map_err(|error| error.to_string())?;
                busy.store(false, Ordering::Relaxed);
                continue;
            }
            // 只 peek，不消费目录缓存事件：随后的拓扑扫描仍必须看到同一批变化。
            let first = state.watch.peek(true);
            state.changes.record(&first);
            let second = state.watch.peek(true);
            state.changes.record(&second);
            let supported = state.watch.change_tracking_supported();
            let same_instance = request.since_instance.as_deref() == Some(state.change_instance.as_str());
            let (changed_files, changed_dirs, mut trusted) = state.changes.changes_since(since);
            trusted &= same_instance && supported && state.watch.trusted()
                && !first.uncertain && !second.uncertain
                && first.coverage_trusted && second.coverage_trusted;
            let payload = serde_json::json!({
                "ok": true,
                "supported": supported,
                "changeSeq": state.changes.sequence,
                "changedFiles": changed_files,
                "changedDirs": changed_dirs,
                "trusted": trusted,
                "changeInstance": state.change_instance,
                "prunedBefore": state.changes.pruned_before,
            });
            writeln!(output, "{payload}")
                .map_err(|error| format!("写 serve 响应失败：{error}"))?;
            output.flush().map_err(|error| error.to_string())?;
            busy.store(false, Ordering::Relaxed);
            continue;
        }
        let pending = state.watch.drain(false);
        state.changes.record(&pending);
        let local_generation = pending.generation;
        let result = if pending.uncertain {
            serve_rescan(&mut state, &root)
        } else if pending.changed_paths.is_empty() {
            // 叶子请求在无事件时仍需复核子树：事件送达可能晚于写入。
            match request.leaf_roots.as_deref() {
                Some(roots) if !roots.is_empty() => serve_cached_for_leaves(&state, roots)
                    .or_else(|_| serve_rescan(&mut state, &root)),
                _ => serve_cached(&state).or_else(|_| serve_rescan(&mut state, &root)),
            }
        } else {
            serve_local(&mut state, &root, &pending)
                .or_else(|_| serve_rescan(&mut state, &root))
        };
        let late = state.watch.drain(true);
        state.changes.record(&late);
        let result = if late.uncertain
            || late.generation != local_generation
            || !late.changed_paths.is_empty()
        {
            let retry = if late.uncertain || late.changed_paths.is_empty() {
                serve_rescan(&mut state, &root)
            } else {
                serve_local(&mut state, &root, &late)
                    .or_else(|_| serve_rescan(&mut state, &root))
            };
            if retry.is_ok() {
                let after = state.watch.drain(false);
                state.changes.record(&after);
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
                let mut payload = serde_json::json!({
                    "ok": true,
                    "directories": response.directories,
                    "cacheHits": response.cache_hits,
                    "repositories": response.repositories,
                    "changeSeq": state.changes.sequence,
                    "changeInstance": state.change_instance,
                });
                if let Some(roots) = &request.leaf_roots {
                    // 叶子与拓扑来自同一次事件排空和复核；无法给出完整列表时拒绝复用。
                    match collect_leaves(&state.directories, roots) {
                        Ok(leaves) if request.if_leaf_digest.as_deref()
                            .is_some_and(|digest| digest == leaf_digest(&leaves)) => {
                            payload["matchedLeafDigest"] = request.if_leaf_digest.into();
                        }
                        Ok(leaves) => payload["leaves"] = leaves.into(),
                        Err(_) => payload["leaves"] = serde_json::Value::Null,
                    }
                }
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
    schema_version: u32,
    #[serde(default)]
    leaf_roots: Option<Vec<String>>,
    #[serde(default)]
    if_leaf_digest: Option<String>,
    /// 查询自该变更序号以来的文件/目录变化；不消费目录缓存事件。
    #[serde(default)]
    since_seq: Option<u64>,
    /// 变更序号所属的 helper 实例；重启后的 helper 不能复用旧序号。
    #[serde(default)]
    since_instance: Option<String>,
    /// 仅用于重置 serve 看门狗，不触发扫描。
    #[serde(default)]
    keep_alive: bool,
}

/// 与完整响应使用同一顺序；每个 UTF-8 路径以 NUL 结尾，名称中的换行等字符不产生歧义。
fn leaf_digest(leaves: &[String]) -> String {
    let mut hash = Sha256::new();
    for path in leaves {
        hash.update(path.as_bytes());
        hash.update([0]);
    }
    hex::encode(hash.finalize())
}

/// 无事件时只返回已建缓存；workspace 身份仍在每次响应前验证。
fn serve_cached(state: &ResidentState) -> Result<HitResponse, String> {
    assert_workspace_identity(state)?;
    serve_cached_body(state)
}

/// 叶子请求额外逐级复核 roots 子树：事件可能仍在路上，不能仅凭「无事件」返回旧 cache。
fn serve_cached_for_leaves(state: &ResidentState, roots: &[String]) -> Result<HitResponse, String> {
    assert_workspace_identity(state)?;
    verify_leaf_subtree(&state.workspace, &state.directories, roots)?;
    serve_cached_body(state)
}

fn serve_cached_body(state: &ResidentState) -> Result<HitResponse, String> {
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
    events: &EventBatch,
) -> Result<HitResponse, String> {
    assert_workspace_identity(state)?;
    let (response, changed_cache, removed, reused) =
    scan_changed(
        root,
        &events.changed_paths,
        &state.directories,
        events.file_entries_only && !events.uncertain,
        events.coverage_trusted && !events.uncertain,
    )
    .map_err(|error| error.to_string())?;
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
        && current.ino() == state.workspace_ino
        && fs::canonicalize(&state.workspace).map_err(|error| error.to_string())? == state.workspace
    ) {
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
    const EVENT_ITEM_INODE_META_MOD: u32 = 0x00000400;
    const EVENT_ITEM_RENAMED: u32 = 0x00000800;
    const EVENT_ITEM_MODIFIED: u32 = 0x00001000;
    const EVENT_ITEM_FINDER_INFO_MOD: u32 = 0x00002000;
    const EVENT_ITEM_CHANGE_OWNER: u32 = 0x00004000;
    const EVENT_ITEM_XATTR_MOD: u32 = 0x00008000;
    const EVENT_ITEM_IS_FILE: u32 = 0x00010000;
    const EVENT_ITEM_IS_DIR: u32 = 0x00020000;
    const EVENT_ITEM_IS_SYMLINK: u32 = 0x00040000;
    const EVENT_ITEM_IS_HARDLINK: u32 = 0x00100000;
    const EVENT_ITEM_IS_LAST_HARDLINK: u32 = 0x00200000;
    const EVENT_ITEM_CLONED: u32 = 0x00400000;
    const MAX_CHANGED_PATHS: usize = 8192;

    struct SharedEvents {
        workspace: String,
        pending: Mutex<EventBatch>,
        generation: AtomicU64,
        running: AtomicBool,
        /// 一旦丢失事件或监听异常就永久降级，后续不再信任时间戳窗口以外的复用。
        trusted: AtomicBool,
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
            events.trusted.store(false, Ordering::Release);
            events.generation.fetch_add(1, Ordering::Release);
            return;
        }
        let paths = event_paths as *const std::ffi::c_void;
        let mut invalidates = false;
        for index in 0..num_events {
            let flags = unsafe { *event_flags.add(index) };
            let value = unsafe { CFArrayGetValueAtIndex(paths, index as isize) };
            let Some(event_path) = cf_string_to_string(value) else {
                pending.uncertain = true;
                pending.coverage_trusted = false;
                events.trusted.store(false, Ordering::Release);
                invalidates = true;
                continue;
            };
            invalidates |= record_event_path(&mut pending, &events.workspace, &event_path, flags);
            if !pending.coverage_trusted {
                events.trusted.store(false, Ordering::Release);
            }
        }
        // 代数只追踪会影响目录缓存的事件，否则 late drain 仍会把纯内容修改升级为全量重扫。
        if invalidates {
            events.generation.fetch_add(1, Ordering::Release);
        }
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

    /// 返回该事件是否使目录缓存失效；纯文件内容由上层快照捕获独立校验。
    fn record_event_path(batch: &mut EventBatch, workspace: &str, path: &str, flags: u32) -> bool {
        const LOSS_FLAGS: u32 = EVENT_MUST_SCAN_SUBDIRS
            | EVENT_USER_DROPPED
            | EVENT_KERNEL_DROPPED
            | EVENT_IDS_WRAPPED
            | EVENT_ROOT_CHANGED
            | EVENT_MOUNT
            | EVENT_UNMOUNT;
        if flags & LOSS_FLAGS != 0 {
            batch.uncertain = true;
            batch.coverage_trusted = false;
            return true;
        }
        let event_path = std::path::Path::new(path);
        let workspace_path = std::path::Path::new(workspace);
        let Ok(relative) = event_path.strip_prefix(workspace_path) else {
            batch.uncertain = true;
            batch.coverage_trusted = false;
            return true;
        };
        let mut components = Vec::new();
        for component in relative.components() {
            match component {
                std::path::Component::Normal(value) => {
                    let Some(value) = value.to_str() else {
                        batch.uncertain = true;
            batch.coverage_trusted = false;
                        return true;
                    };
                    components.push(value);
                }
                std::path::Component::CurDir => {}
                _ => {
                    batch.uncertain = true;
            batch.coverage_trusted = false;
                    return true;
                }
            }
        }
        let relative_path = components.join("/");
        // 普通文件覆盖可同时携带 inode 元数据标志；它不改变目录项名称或类型。
        // 只接受这两个确切组合，合并的结构变化、其他元数据变化和未知位均保留复核。
        // 忽略规则、仓库指针、内容及权限仍由调用方实时读取，不依赖这里的目录缓存。
        let content_flags = EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED;
        if !relative_path.is_empty()
            && (flags == content_flags || flags == (content_flags | EVENT_ITEM_INODE_META_MOD))
        {
            batch.record_file(relative_path);
            return false;
        }
        // 即使文件的 Created 与 Modified 合并，也必须重读父目录；只有其无事件子树可复用。
        // 不接受未知位、符号链接或目录结构事件，避免把类型变化误判为普通文件变化。
        const FILE_FLAGS: u32 = EVENT_ITEM_IS_FILE | EVENT_ITEM_CREATED | EVENT_ITEM_REMOVED
            | EVENT_ITEM_RENAMED | EVENT_ITEM_MODIFIED | EVENT_ITEM_INODE_META_MOD
            | EVENT_ITEM_FINDER_INFO_MOD | EVENT_ITEM_CHANGE_OWNER | EVENT_ITEM_XATTR_MOD
            | EVENT_ITEM_IS_HARDLINK | EVENT_ITEM_IS_LAST_HARDLINK | EVENT_ITEM_CLONED;
        let file_entry = !relative_path.is_empty()
            && flags & EVENT_ITEM_IS_FILE != 0
            && flags & (FILE_FLAGS & !(EVENT_ITEM_IS_FILE | EVENT_ITEM_IS_HARDLINK | EVENT_ITEM_IS_LAST_HARDLINK)) != 0
            && flags & !FILE_FLAGS == 0;
        let directory_metadata = flags == (EVENT_ITEM_IS_DIR | EVENT_ITEM_INODE_META_MOD);
        batch.file_entries_only &= file_entry || directory_metadata;
        let is_directory = flags & EVENT_ITEM_IS_DIR != 0;
        let is_file_like = flags & (EVENT_ITEM_IS_FILE | EVENT_ITEM_IS_SYMLINK) != 0;
        if !is_directory && !is_file_like {
            batch.uncertain = true;
            batch.coverage_trusted = false;
            return true;
        }
        let parent = std::path::Path::new(&relative_path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .and_then(std::path::Path::to_str)
            .unwrap_or("")
            .to_owned();
        if is_directory {
            batch.record_dir(relative_path.clone());
            insert_changed_path(batch, relative_path.clone());
            if flags & (EVENT_ITEM_CREATED | EVENT_ITEM_REMOVED | EVENT_ITEM_RENAMED) != 0 {
                insert_changed_path(batch, parent);
            }
            return true;
        }
        batch.record_file(relative_path);
        insert_changed_path(batch, parent);
        true
    }

    fn insert_changed_path(batch: &mut EventBatch, path: String) {
        if batch.changed_paths.len() >= MAX_CHANGED_PATHS && !batch.changed_paths.contains(&path) {
            batch.uncertain = true;
            batch.coverage_trusted = false;
            batch.changed_paths.clear();
            return;
        }
        batch.changed_paths.insert(path);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn shared_events() -> SharedEvents {
            SharedEvents {
                workspace: "/workspace".into(),
                pending: Mutex::new(EventBatch {
                    generation: 0,
                    changed_paths: HashSet::new(),
                    changed_files: HashSet::new(),
                    changed_dirs: HashSet::new(),
                    uncertain: false,
                    file_entries_only: true,
                    coverage_trusted: true,
                }),
                generation: AtomicU64::new(0),
                running: AtomicBool::new(true),
                trusted: AtomicBool::new(true),
            }
        }

        /// 经实际 FSEvents 回调注入批次，覆盖路径分类与代数更新的组合行为。
        fn emit_events(events: &SharedEvents, items: &[(&str, u32)]) {
            let paths = items.iter().map(|(path, _)| {
                let path = CString::new(*path).unwrap();
                let value = unsafe {
                    CFStringCreateWithCString(std::ptr::null(), path.as_ptr(), K_CFSTRINGENCODING_UTF8)
                };
                assert!(!value.is_null());
                value
            }).collect::<Vec<_>>();
            let array = unsafe {
                CFArrayCreate(std::ptr::null(), paths.as_ptr(), paths.len() as isize, std::ptr::null())
            };
            assert!(!array.is_null());
            let flags = items.iter().map(|(_, flags)| *flags).collect::<Vec<_>>();
            on_events(
                std::ptr::null(), events as *const SharedEvents as *mut _,
                paths.len(), array, flags.as_ptr(), std::ptr::null(),
            );
            unsafe {
                CFRelease(array);
                for path in paths { CFRelease(path); }
            }
        }

        #[test]
        fn content_only_events_preserve_directory_cache_generation() {
            let events = shared_events();
            emit_events(&events, &[
                ("/workspace/value.txt", EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED),
                ("/workspace/deep/file", EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED | EVENT_ITEM_INODE_META_MOD),
            ]);
            assert_eq!(events.generation.load(Ordering::Acquire), 0);
            let pending = events.pending.lock().unwrap();
            assert!(pending.changed_paths.is_empty());
            assert_eq!(pending.changed_files, HashSet::from(["value.txt".into(), "deep/file".into()]));
            assert!(pending.changed_dirs.is_empty());
            assert!(!pending.uncertain);
        }

        #[test]
        fn coalesced_or_unknown_flags_never_take_the_content_only_path() {
            let pure = EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED;
            for flags in [pure, pure | EVENT_ITEM_INODE_META_MOD] {
                for bit in 0..32 {
                    let extra = 1u32 << bit;
                    if extra & (pure | EVENT_ITEM_INODE_META_MOD) != 0 { continue; }
                    let events = shared_events();
                    emit_events(&events, &[("/workspace/repo/file", flags | extra)]);
                    assert_eq!(events.generation.load(Ordering::Acquire), 1);
                    let pending = events.pending.lock().unwrap();
                    assert!(pending.uncertain || !pending.changed_paths.is_empty());
                }
            }
            for flags in [EVENT_ITEM_MODIFIED, EVENT_ITEM_IS_FILE, EVENT_ITEM_IS_FILE | EVENT_ITEM_INODE_META_MOD,
                EVENT_ITEM_IS_DIR | EVENT_ITEM_MODIFIED, EVENT_ITEM_IS_SYMLINK | EVENT_ITEM_MODIFIED] {
                let events = shared_events();
                emit_events(&events, &[("/workspace/repo/file", flags)]);
                assert_eq!(events.generation.load(Ordering::Acquire), 1);
            }
        }

        #[test]
        fn content_events_do_not_hide_structural_events_or_unsafe_paths() {
            let events = shared_events();
            let modified = EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED;
            let created = EVENT_ITEM_IS_FILE | EVENT_ITEM_CREATED;
            emit_events(&events, &[
                ("/workspace/value.txt", modified),
                ("/workspace/deps/new", created),
            ]);
            assert_eq!(events.generation.load(Ordering::Acquire), 1);
            assert_eq!(events.pending.lock().unwrap().changed_paths, HashSet::from(["deps".into()]));
            assert_eq!(events.pending.lock().unwrap().changed_files, HashSet::from(["deps/new".into(), "value.txt".into()]));
            // 同一路径再次变化仍推进代数；纯内容事件不得清除尚未消费的变化。
            emit_events(&events, &[("/workspace/deps/new", created)]);
            emit_events(&events, &[("/workspace/value.txt", modified)]);
            assert_eq!(events.generation.load(Ordering::Acquire), 2);
            assert!(events.pending.lock().unwrap().changed_paths.contains("deps"));
            assert_eq!(events.pending.lock().unwrap().changed_files, HashSet::from(["deps/new".into(), "value.txt".into()]));
            for path in ["/outside/value.txt", "/workspace/../outside/value.txt"] {
                let events = shared_events();
                emit_events(&events, &[(path, modified)]);
                assert!(events.pending.lock().unwrap().uncertain);
                assert_eq!(events.generation.load(Ordering::Acquire), 1);
            }
        }

        #[test]
        fn event_loss_permanently_disables_trusted_coverage() {
            let events = shared_events();
            emit_events(&events, &[("/workspace/repo/file", EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED)]);
            assert!(events.trusted.load(Ordering::Acquire));
            assert!(events.pending.lock().unwrap().coverage_trusted);
            emit_events(&events, &[("/workspace/repo/file", EVENT_KERNEL_DROPPED)]);
            assert!(!events.trusted.load(Ordering::Acquire));
            assert!(!events.pending.lock().unwrap().coverage_trusted);
            // 后续普通内容事件不能恢复信任。
            emit_events(&events, &[("/workspace/repo/file", EVENT_ITEM_IS_FILE | EVENT_ITEM_MODIFIED)]);
            assert!(!events.trusted.load(Ordering::Acquire));
        }

        #[test]
        fn only_known_file_batches_allow_racy_sibling_reuse() {
            let known = EVENT_ITEM_IS_FILE | EVENT_ITEM_CREATED | EVENT_ITEM_MODIFIED | EVENT_ITEM_INODE_META_MOD;
            let events = shared_events();
            emit_events(&events, &[
                ("/workspace/value.txt", known),
                ("/workspace", EVENT_ITEM_IS_DIR | EVENT_ITEM_INODE_META_MOD),
                ("/workspace/other", EVENT_ITEM_IS_FILE | EVENT_ITEM_RENAMED | EVENT_ITEM_IS_HARDLINK),
            ]);
            assert!(events.pending.lock().unwrap().file_entries_only);
            assert!(events.pending.lock().unwrap().changed_paths.contains(""));
            for flags in [EVENT_ITEM_IS_DIR | EVENT_ITEM_CREATED,
                EVENT_ITEM_IS_DIR | EVENT_ITEM_RENAMED,
                EVENT_ITEM_IS_DIR | EVENT_ITEM_MODIFIED,
                EVENT_ITEM_IS_SYMLINK | EVENT_ITEM_CREATED,
                known | 0x80000000, EVENT_ITEM_IS_FILE, EVENT_USER_DROPPED] {
                let events = shared_events();
                emit_events(&events, &[("/workspace/value.txt", known), ("/workspace/deps", flags)]);
                emit_events(&events, &[("/workspace/value.txt", known)]);
                let pending = events.pending.lock().unwrap();
                assert!(pending.uncertain || !pending.file_entries_only);
            }
        }

        #[test]
        fn file_and_directory_events_invalidate_their_parent_chain() {
            let mut batch = EventBatch {
                generation: 0,
                changed_paths: HashSet::new(),
                changed_files: HashSet::new(),
                changed_dirs: HashSet::new(),
                uncertain: false,
                file_entries_only: true,
                coverage_trusted: true,
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
            assert_eq!(batch.changed_files, HashSet::from(["repo/src/main.rs".into()]));
            assert_eq!(batch.changed_dirs, HashSet::from(["repo/new-dir".into()]));
        }

        #[test]
        fn uncertain_event_batches_force_a_full_rescan() {
            let mut batch = EventBatch {
                generation: 0,
                changed_paths: HashSet::new(),
                changed_files: HashSet::new(),
                changed_dirs: HashSet::new(),
                uncertain: false,
                file_entries_only: true,
                coverage_trusted: true,
            };
            for flags in [EVENT_MUST_SCAN_SUBDIRS, EVENT_USER_DROPPED, EVENT_KERNEL_DROPPED,
                EVENT_IDS_WRAPPED, EVENT_ROOT_CHANGED, EVENT_MOUNT, EVENT_UNMOUNT] {
                batch.uncertain = false;
                record_event_path(&mut batch, "/workspace", "/workspace/repo", flags);
                assert!(batch.uncertain);
            }

            let mut batch = EventBatch {
                generation: 0,
                changed_paths: HashSet::new(),
                changed_files: HashSet::new(),
                changed_dirs: HashSet::new(),
                uncertain: false,
                file_entries_only: true,
                coverage_trusted: true,
            };
            record_event_path(&mut batch, "/workspace", "/outside/repo", EVENT_ITEM_IS_DIR);
            assert!(batch.uncertain);
            batch.uncertain = false;
            batch.changed_paths.clear();
            for index in 0..=MAX_CHANGED_PATHS {
                insert_changed_path(&mut batch, format!("dir-{index}"));
            }
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
                    changed_files: HashSet::new(),
                    changed_dirs: HashSet::new(),
                    uncertain: false,
                    file_entries_only: true,
                    coverage_trusted: true,
                }),
                generation: AtomicU64::new(0),
                running: AtomicBool::new(false),
                trusted: AtomicBool::new(true),
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
            let trusted = self.events.trusted.load(Ordering::Acquire);
            let mut pending = match self.events.pending.lock() {
                Ok(pending) => pending,
                Err(_) => return EventBatch::unknown(),
            };
            let changed_paths = std::mem::take(&mut pending.changed_paths);
            let changed_files = std::mem::take(&mut pending.changed_files);
            let changed_dirs = std::mem::take(&mut pending.changed_dirs);
            let uncertain = std::mem::replace(&mut pending.uncertain, false);
            let file_entries_only = std::mem::replace(&mut pending.file_entries_only, true);
            let batch_trusted = std::mem::replace(&mut pending.coverage_trusted, trusted);
            EventBatch {
                generation,
                changed_paths,
                changed_files,
                changed_dirs,
                uncertain,
                file_entries_only,
                coverage_trusted: trusted && batch_trusted,
            }
        }

        /// 与 drain 使用同一套排空与信任判定，但不消费 pending；目录缓存仍需看到这些事件。
        pub(super) fn peek(&self, settle: bool) -> EventBatch {
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
            let trusted = self.events.trusted.load(Ordering::Acquire);
            let pending = match self.events.pending.lock() {
                Ok(pending) => pending,
                Err(_) => return EventBatch::unknown(),
            };
            EventBatch {
                generation,
                changed_paths: pending.changed_paths.clone(),
                changed_files: pending.changed_files.clone(),
                changed_dirs: pending.changed_dirs.clone(),
                uncertain: pending.uncertain,
                file_entries_only: pending.file_entries_only,
                coverage_trusted: trusted && pending.coverage_trusted,
            }
        }

        pub(super) fn change_tracking_supported(&self) -> bool {
            true
        }

        pub(super) fn trusted(&self) -> bool {
            self.events.trusted.load(Ordering::Acquire)
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

#[cfg(target_os = "linux")]
#[path = "watch_linux.rs"]
mod watch_impl;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod watch_impl {
    use super::EventBatch;

    // 其他平台暂不提供常驻模式：--serve 直接返回不支持。
    pub(super) struct Watch;
    impl Watch {
        pub(super) fn create(_workspace: &std::path::Path) -> Result<Self, String> {
            Err("当前平台不支持常驻扫描".into())
        }
        pub(super) fn drain(&self, _settle: bool) -> EventBatch {
            EventBatch::unknown()
        }
        pub(super) fn peek(&self, _settle: bool) -> EventBatch {
            EventBatch::unknown()
        }
        pub(super) fn change_tracking_supported(&self) -> bool {
            false
        }
        pub(super) fn trusted(&self) -> bool {
            false
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
