use crate::directory::{Directory, same_directory};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    workspace_root: String,
    #[serde(default)]
    cache_path: Option<String>,
}

const CACHE_SCHEMA_VERSION: u32 = 2;
const RACY_DIRECTORY_WINDOW_NS: u128 = 2_000_000_000;
static NEXT_CACHE_WRITE: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryCache {
    schema_version: u32,
    workspace_root: String,
    workspace_dev: u64,
    workspace_ino: u64,
    directories: BTreeMap<String, CachedDirectory>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedDirectory {
    dev: u64,
    ino: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
    has_git: bool,
    racy: bool,
    children: Vec<String>,
}

struct ScanState<'a> {
    previous: Option<&'a DirectoryCache>,
    next: BTreeMap<String, CachedDirectory>,
    reused_directories: usize,
}

#[derive(Serialize)]
struct Repository {
    path: String,
    dev: String,
    ino: String,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    directories: usize,
    repositories: Vec<Repository>,
}

pub(crate) fn run(request_path: &Path) -> Result<(), String> {
    let request: Request = serde_json::from_slice(
        &fs::read(request_path).map_err(|error| format!("读取目录扫描请求失败：{error}"))?,
    )
    .map_err(|error| format!("解析目录扫描请求失败：{error}"))?;
    if request.schema_version != 1 && request.schema_version != 2 {
        return Err("目录扫描 schemaVersion 不受支持".into());
    }
    if request.schema_version == 2 && request.cache_path.is_none() {
        return Err("增量目录扫描缺少 cachePath".into());
    }
    let workspace = Path::new(&request.workspace_root);
    if fs::canonicalize(workspace).map_err(|error| error.to_string())? != workspace {
        return Err("workspaceRoot 必须是 canonical path".into());
    }
    let root = Directory::open(workspace).map_err(|error| error.to_string())?;
    let previous_cache = if request.schema_version == 2 {
        request
            .cache_path
            .as_deref()
            .and_then(|path| load_cache(Path::new(path), &root, workspace))
    } else {
        None
    };
    let mut scan_state = ScanState {
        previous: previous_cache.as_ref(),
        next: BTreeMap::new(),
        reused_directories: 0,
    };
    let mut response = Response {
        ok: true,
        directories: 0,
        repositories: Vec::new(),
    };
    match scan(&root, "", 0, &mut response, &mut scan_state) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => {
            println!("{{\"ok\":false,\"code\":\"depth_limit\"}}");
            return Ok(());
        }
        Err(error) => return Err(format!("目录扫描失败：{error}")),
    }
    if fs::canonicalize(workspace).map_err(|error| error.to_string())? != workspace
        || !same_directory(
            &fs::symlink_metadata(workspace).map_err(|error| error.to_string())?,
            &root.file.metadata().map_err(|error| error.to_string())?,
        )
    {
        return Err("目录扫描期间 workspace 身份发生变化".into());
    }
    if request.schema_version == 2 {
        if let Some(cache_path) = request.cache_path.as_deref() {
            if let Err(error) =
                write_cache(Path::new(cache_path), workspace, &root, scan_state.next)
            {
                eprintln!("写入目录扫描 cache 失败，忽略 cache：{error}");
            }
        }
    }
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn scan(
    directory: &Directory,
    path: &str,
    depth: usize,
    response: &mut Response,
    state: &mut ScanState<'_>,
) -> std::io::Result<()> {
    if depth > 128 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "目录扫描深度超过限制",
        ));
    }
    let before = directory.file.metadata()?;
    if let Some(cached) = state
        .previous
        .and_then(|cache| cache.directories.get(path))
        .cloned()
    {
        let mut reusable = metadata_matches(&cached, &before) && !cached.racy;
        if reusable {
            for name in &cached.children {
                match directory.open_child(OsStr::new(name)) {
                    Ok(_child) => {}
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound
                            || error.kind() == std::io::ErrorKind::NotADirectory =>
                    {
                        reusable = false;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        if reusable {
            response.directories += 1;
            state.reused_directories += 1;
            if !path.is_empty() && cached.has_git {
                response.repositories.push(Repository {
                    path: path.into(),
                    dev: before.dev().to_string(),
                    ino: before.ino().to_string(),
                });
            }
            state.next.insert(path.into(), cached.clone());
            for name in cached.children {
                let child = directory.open_child(OsStr::new(&name))?;
                let child_path = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}/{name}")
                };
                scan(&child, &child_path, depth + 1, response, state)?;
                directory.assert_child(OsStr::new(&name), &child)?;
            }
            let after = directory.file.metadata()?;
            assert_unchanged(path, &before, &after)?;
            return Ok(());
        }
    }

    let entries = directory.entries()?;
    response.directories += 1;
    let has_git = !path.is_empty()
        && entries
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(".git"));
    if has_git {
        response.repositories.push(Repository {
            path: path.into(),
            dev: before.dev().to_string(),
            ino: before.ino().to_string(),
        });
    }
    let mut children = Vec::new();
    for (name, kind) in entries {
        if name == ".git" {
            continue;
        }
        let name_os = OsStr::new(&name);
        let is_directory = kind == libc::DT_DIR
            || (kind == libc::DT_UNKNOWN
                && directory.stat(name_os)?.st_mode & libc::S_IFMT == libc::S_IFDIR);
        if !is_directory {
            continue;
        }
        children.push(name.clone());
        let child = directory.open_child(name_os)?;
        let child_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        scan(&child, &child_path, depth + 1, response, state)?;
        directory.assert_child(name_os, &child)?;
    }
    let after = directory.file.metadata()?;
    assert_unchanged(path, &before, &after)?;
    state
        .next
        .insert(path.into(), cached_directory(&after, has_git, children));
    Ok(())
}

fn assert_unchanged(
    path: &str,
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
) -> std::io::Result<()> {
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(std::io::Error::other(format!(
            "扫描期间目录发生变化：{path}"
        )));
    }
    Ok(())
}

fn cached_directory(
    metadata: &std::fs::Metadata,
    has_git: bool,
    children: Vec<String>,
) -> CachedDirectory {
    CachedDirectory {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mtime: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
        ctime: metadata.ctime(),
        ctime_nsec: metadata.ctime_nsec(),
        has_git,
        racy: directory_is_racy(metadata),
        children,
    }
}

fn metadata_matches(cached: &CachedDirectory, metadata: &std::fs::Metadata) -> bool {
    cached.dev == metadata.dev()
        && cached.ino == metadata.ino()
        && cached.mtime == metadata.mtime()
        && cached.mtime_nsec == metadata.mtime_nsec()
        && cached.ctime == metadata.ctime()
        && cached.ctime_nsec == metadata.ctime_nsec()
}

fn directory_is_racy(metadata: &std::fs::Metadata) -> bool {
    metadata.mtime_nsec() == 0 || metadata.ctime_nsec() == 0 || directory_is_recent(metadata)
}

fn directory_is_recent(metadata: &std::fs::Metadata) -> bool {
    let Some(now) = SystemTime::now().duration_since(UNIX_EPOCH).ok() else {
        return true;
    };
    let now = now.as_nanos();
    [
        timestamp_nanos(metadata.mtime(), metadata.mtime_nsec()),
        timestamp_nanos(metadata.ctime(), metadata.ctime_nsec()),
    ]
    .into_iter()
    .flatten()
    .any(|stamp| stamp > now || now.saturating_sub(stamp) < RACY_DIRECTORY_WINDOW_NS)
}

fn timestamp_nanos(seconds: i64, nanos: i64) -> Option<u128> {
    if seconds < 0 || nanos < 0 {
        return None;
    }
    Some(seconds as u128 * 1_000_000_000 + nanos as u128)
}

fn load_cache(path: &Path, root: &Directory, workspace: &Path) -> Option<DirectoryCache> {
    let cache: DirectoryCache = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let root_metadata = root.file.metadata().ok()?;
    if cache.schema_version != CACHE_SCHEMA_VERSION
        || cache.workspace_root != workspace.to_string_lossy()
        || cache.workspace_dev != root_metadata.dev()
        || cache.workspace_ino != root_metadata.ino()
        || !cache.directories.contains_key("")
        || !cache.directories.iter().all(|(path, directory)| {
            valid_directory_path(path) && valid_children(&directory.children)
        })
    {
        return None;
    }
    Some(cache)
}

fn valid_directory_path(path: &str) -> bool {
    path.is_empty()
        || path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && part != ".git")
}

fn valid_child_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name != ".git" && !name.contains('/')
}

fn valid_children(children: &[String]) -> bool {
    let mut seen = HashSet::with_capacity(children.len());
    children
        .iter()
        .all(|name| valid_child_name(name) && seen.insert(name))
}

fn write_cache(
    path: &Path,
    workspace: &Path,
    root: &Directory,
    directories: BTreeMap<String, CachedDirectory>,
) -> std::io::Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(std::io::Error::other("目录扫描 cachePath 不能是符号链接"));
        }
    }
    let metadata = root.file.metadata()?;
    let cache = DirectoryCache {
        schema_version: CACHE_SCHEMA_VERSION,
        workspace_root: workspace.to_string_lossy().into_owned(),
        workspace_dev: metadata.dev(),
        workspace_ino: metadata.ino(),
        directories,
    };
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_CACHE_WRITE.fetch_add(1, Ordering::Relaxed),
    ));
    fs::write(
        &temporary,
        serde_json::to_vec(&cache).map_err(std::io::Error::other)?,
    )?;
    fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn verified_cache(root: &Path) -> DirectoryCache {
        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: None,
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        for directory in state.next.values_mut() {
            directory.racy = false;
        }
        let metadata = fs::metadata(root).unwrap();
        DirectoryCache {
            schema_version: CACHE_SCHEMA_VERSION,
            workspace_root: root.to_string_lossy().into_owned(),
            workspace_dev: metadata.dev(),
            workspace_ino: metadata.ino(),
            directories: state.next,
        }
    }

    #[test]
    fn scans_ignored_directories_and_markers_without_following_symlinks() {
        let root = crate::tests::fixture();
        fs::create_dir_all(root.join("node_modules/pkg/.git/objects")).unwrap();
        fs::create_dir_all(root.join("broken/.git")).unwrap();
        fs::write(root.join("node_modules/.gitignore"), "*").unwrap();
        symlink(root.join("node_modules"), root.join("link")).unwrap();
        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: None,
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(&root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        response.repositories.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(response.directories, 4);
        assert_eq!(
            response
                .repositories
                .iter()
                .map(|r| r.path.as_str())
                .collect::<Vec<_>>(),
            ["broken", "node_modules/pkg"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reuses_verified_directories_and_falls_back_when_structure_changes() {
        let root = crate::tests::fixture();
        fs::create_dir_all(root.join("repo/nested")).unwrap();
        fs::write(root.join("keep.txt"), "keep").unwrap();
        let cache = verified_cache(&root);

        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: Some(&cache),
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(&root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        assert_eq!(response.directories, 3);
        assert_eq!(state.reused_directories, 3);

        fs::create_dir(root.join("repo/nested/.git")).unwrap();
        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: Some(&cache),
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(&root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        assert_eq!(
            response
                .repositories
                .iter()
                .map(|item| item.path.as_str())
                .collect::<Vec<_>>(),
            ["repo/nested"]
        );
        assert_eq!(state.reused_directories, 2);

        fs::remove_dir_all(root.join("repo/nested")).unwrap();
        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: Some(&cache),
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(&root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        assert_eq!(response.directories, 2);
        assert_eq!(state.reused_directories, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn racy_cache_entry_is_always_rescanned() {
        let root = crate::tests::fixture();
        fs::create_dir(root.join("child")).unwrap();
        let mut cache = verified_cache(&root);
        for directory in cache.directories.values_mut() {
            directory.racy = true;
        }
        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: Some(&cache),
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(&root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        assert_eq!(state.reused_directories, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_stale_or_corrupt_directory_cache() {
        let root = crate::tests::fixture();
        fs::create_dir(root.join("child")).unwrap();
        let mut response = Response {
            ok: true,
            directories: 0,
            repositories: Vec::new(),
        };
        let mut state = ScanState {
            previous: None,
            next: BTreeMap::new(),
            reused_directories: 0,
        };
        scan(
            &Directory::open(&root).unwrap(),
            "",
            0,
            &mut response,
            &mut state,
        )
        .unwrap();
        let cache_path = root.join("cache.json");
        write_cache(
            &cache_path,
            &root,
            &Directory::open(&root).unwrap(),
            state.next,
        )
        .unwrap();
        let opened = Directory::open(&root).unwrap();
        assert!(load_cache(&cache_path, &opened, &root).is_some());

        let other = crate::tests::fixture();
        assert!(load_cache(&cache_path, &Directory::open(&other).unwrap(), &other).is_none());

        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
        value["directories"][""]["children"] = serde_json::json!(["child", "child"]);
        fs::write(&cache_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(load_cache(&cache_path, &opened, &root).is_none());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn rejects_replaced_directory_binding() {
        let root = crate::tests::fixture();
        fs::create_dir(root.join("child")).unwrap();
        let parent = Directory::open(&root).unwrap();
        let child = parent.open_child(OsStr::new("child")).unwrap();
        fs::rename(root.join("child"), root.join("old")).unwrap();
        fs::create_dir(root.join("child")).unwrap();
        assert!(parent.assert_child(OsStr::new("child"), &child).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
