use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

const MAGIC: &[u8] = b"PIUNDO-PACK-V1\0";
const CONCURRENCY: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    schema_version: u32,
    op_id: String,
    pack_op_id: String,
    plan_digest: String,
    workspace_root: String,
    pack_path: String,
    pack_checksum: String,
    entries: Vec<RequestEntry>,
    #[serde(default)]
    verify_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestEntry {
    path: String,
    source_artifact: String,
    target_artifact: Option<String>,
    source_fingerprint: String,
    target_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackHeader {
    schema_version: u32,
    op_id: String,
    plan_digest: String,
    entries: Vec<PackEntry>,
    checksum: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackEntry {
    path: String,
    source_artifact: String,
    target_artifact: Option<String>,
    source_fingerprint: String,
    target_fingerprint: Option<String>,
    variants: Vec<PackVariant>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackVariant {
    kind: String,
    fingerprint: String,
    mode: Option<u32>,
    offset: Option<u64>,
    length: Option<u64>,
    data_checksum: Option<String>,
}

struct PackedOperation {
    source_artifact: String,
    target_artifact: Option<String>,
    source_fingerprint: String,
    target_fingerprint: Option<String>,
    variants: BTreeMap<String, PackVariant>,
}

struct Pack {
    bytes: Vec<u8>,
    payload_start: usize,
    entries: BTreeMap<String, PackedOperation>,
}

#[cfg(unix)]
struct ParentDirectory {
    file: fs::File,
}

struct OperationEntry {
    path: String,
    original: PathBuf,
    source: PathBuf,
    target: Option<PathBuf>,
    source_variant: PackVariant,
    target_variant: PackVariant,
    #[cfg(unix)]
    parent: Option<Arc<ParentDirectory>>,
    #[cfg(unix)]
    original_name: Option<String>,
    #[cfg(unix)]
    source_name: Option<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let first = std::env::args().nth(1).ok_or("缺少 request path")?;
    if first == "--capabilities" {
        #[cfg(unix)]
        println!(
            "{}",
            r#"{"ok":true,"capabilities":["restore-v1","inspect-v1"]}"#
        );
        #[cfg(not(unix))]
        println!("{}", r#"{"ok":true,"capabilities":["restore-v1"]}"#);
        return Ok(());
    }
    if first == "--inspect" {
        let request_path = std::env::args().nth(2).ok_or("缺少 inspect request path")?;
        return run_inspect(Path::new(&request_path));
    }
    run_restore(Path::new(&first))
}

fn run_restore(request_path: &Path) -> Result<(), String> {
    let request_bytes = fs::read(request_path).map_err(error("读取 request 失败"))?;
    let request: Request = serde_json::from_slice(&request_bytes)
        .map_err(|error| format!("解析 request 失败: {error}"))?;
    if request.schema_version != 1 || request.op_id.is_empty() {
        return Err("request identity 不受支持".into());
    }
    let workspace =
        fs::canonicalize(&request.workspace_root).map_err(error("workspace canonicalize 失败"))?;
    if workspace.as_path() != Path::new(&request.workspace_root) {
        return Err("workspaceRoot 必须是 canonical path".into());
    }
    let pack = load_pack(
        Path::new(&request.pack_path),
        &request.pack_op_id,
        &request.plan_digest,
        &request.pack_checksum,
    )?;
    if request.entries.len() != pack.entries.len() {
        return Err("request 与 pack 路径数量不匹配".into());
    }
    #[cfg(unix)]
    let workspace_parent = Arc::new(open_parent_directory(&workspace)?);
    let mut operations = Vec::with_capacity(request.entries.len());
    let mut requested_paths = BTreeMap::new();
    for entry in request.entries {
        if requested_paths.insert(entry.path.clone(), ()).is_some() {
            return Err(format!("request 路径重复：{}", entry.path));
        }
        let packed = pack
            .entries
            .get(&entry.path)
            .ok_or_else(|| format!("pack 缺少路径：{}", entry.path))?;
        if packed.source_artifact != entry.source_artifact
            || packed.target_artifact.as_deref() != entry.target_artifact.as_deref()
            || packed.source_fingerprint != entry.source_fingerprint
            || packed.target_fingerprint.as_deref() != Some(entry.target_fingerprint.as_str())
        {
            return Err(format!("request 与 pack entry 不匹配：{}", entry.path));
        }
        let original = safe_path(&workspace, &entry.path)?;
        let source = safe_artifact(&workspace, &entry.path, &entry.source_artifact, "source")?;
        let target = entry
            .target_artifact
            .as_ref()
            .map(|artifact| safe_artifact(&workspace, &entry.path, artifact, "target"))
            .transpose()?;
        #[cfg(unix)]
        let (parent, original_name, source_name) = if target.is_none() {
            let original_parent = original
                .parent()
                .ok_or_else(|| format!("路径缺少 parent：{}", entry.path))?;
            if original_parent != workspace {
                return Err(format!(
                    "native delete 只允许 workspace 直属普通文件：{}",
                    entry.path
                ));
            }
            let original_name = original
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("文件名无效：{}", entry.path))?;
            let source_name = source
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("source 文件名无效：{}", entry.path))?;
            (
                Some(Arc::clone(&workspace_parent)),
                Some(original_name.to_owned()),
                Some(source_name.to_owned()),
            )
        } else {
            (None, None, None)
        };
        #[cfg(not(unix))]
        if target.is_none() {
            return Err("当前平台 native delete 不支持，回退 TypeScript restore".into());
        }
        let source_variant = packed
            .variants
            .get(&entry.source_fingerprint)
            .ok_or_else(|| format!("pack 缺少 source variant：{}", entry.path))?
            .clone();
        let target_variant = packed
            .variants
            .get(&entry.target_fingerprint)
            .ok_or_else(|| format!("pack 缺少 target variant：{}", entry.path))?
            .clone();
        if source_variant.kind != "absent" && source_variant.kind != "file" {
            return Err(format!("native batch source 不是普通文件：{}", entry.path));
        }
        if target.is_none() && source_variant.kind != "file" {
            return Err(format!("native delete source 不是普通文件：{}", entry.path));
        }
        if target.is_none() && target_variant.kind != "absent" {
            return Err(format!("native delete target 不是 absent：{}", entry.path));
        }
        if target.is_some() && target_variant.kind != "file" {
            return Err(format!("native batch target 不是普通文件：{}", entry.path));
        }
        operations.push(OperationEntry {
            path: entry.path,
            original,
            source,
            target,
            source_variant,
            target_variant,
            #[cfg(unix)]
            parent,
            #[cfg(unix)]
            original_name,
            #[cfg(unix)]
            source_name,
        });
    }
    let operations = Arc::new(operations);
    let pack = Arc::new(pack);
    if request.verify_only {
        parallel(&operations, |entry| verify_source(&pack, entry))?;
        println!("{{\"ok\":true,\"processed\":{}}}", operations.len());
        return Ok(());
    }

    parallel(&operations, |entry| create_target(&pack, entry))?;
    parallel(&operations, |entry| capture_source(&pack, entry))?;
    parallel_with_limit(&operations, 4, |entry| install_target(&pack, entry))?;
    parallel(&operations, |entry| verify_installed(&pack, entry))?;

    println!("{{\"ok\":true,\"processed\":{}}}", operations.len());
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectRequest {
    schema_version: u32,
    workspace_root: String,
    paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectResponse {
    ok: bool,
    processed: usize,
    entries: Vec<InspectEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectEntry {
    path: String,
    kind: String,
    dev: Option<String>,
    ino: Option<String>,
    mode: Option<String>,
    size: Option<String>,
    mtime_ns: Option<String>,
    ctime_ns: Option<String>,
}

fn run_inspect(request_path: &Path) -> Result<(), String> {
    let request_bytes = fs::read(request_path).map_err(error("读取 inspect request 失败"))?;
    let request: InspectRequest = serde_json::from_slice(&request_bytes)
        .map_err(|error| format!("解析 inspect request 失败: {error}"))?;
    if request.schema_version != 1 {
        return Err("inspect schemaVersion 不受支持".into());
    }
    let workspace =
        fs::canonicalize(&request.workspace_root).map_err(error("workspace canonicalize 失败"))?;
    if workspace.as_path() != Path::new(&request.workspace_root) {
        return Err("workspaceRoot 必须是 canonical path".into());
    }
    #[cfg(not(unix))]
    return Err("当前平台 native metadata inspect 不受支持".into());
    #[cfg(unix)]
    {
        let mut seen = BTreeSet::new();
        let mut parents = BTreeSet::new();
        for path in &request.paths {
            validate_relative_path(path)?;
            if !seen.insert(path.clone()) {
                return Err(format!("inspect 路径重复：{path}"));
            }
            let parts = Path::new(path).components().collect::<Vec<_>>();
            let mut parent = PathBuf::new();
            for component in parts.iter().take(parts.len().saturating_sub(1)) {
                if let Component::Normal(value) = component {
                    parent.push(value);
                    parents.insert(parent.clone());
                }
            }
        }
        assert_inspect_parents(&workspace, &parents)?;
        let entries = parallel_inspect(&workspace, request.paths)?;
        assert_inspect_parents(&workspace, &parents)?;
        let response = InspectResponse {
            ok: true,
            processed: entries.len(),
            entries,
        };
        println!(
            "{}",
            serde_json::to_string(&response)
                .map_err(|error| format!("编码 inspect response 失败: {error}"))?
        );
        Ok(())
    }
}

fn validate_relative_path(relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("不安全 inspect 路径：{relative}"));
    }
    Ok(())
}

#[cfg(unix)]
fn assert_inspect_parents(workspace: &Path, parents: &BTreeSet<PathBuf>) -> Result<(), String> {
    for parent in parents {
        match fs::symlink_metadata(workspace.join(parent)) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("inspect 中间路径是 symlink：{}", parent.display()));
            }
            Ok(metadata) if !metadata.file_type().is_dir() => {
                return Err(format!("inspect 中间路径不是目录：{}", parent.display()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "inspect 父目录 metadata 失败：{}: {error}",
                    parent.display()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn parallel_inspect(workspace: &Path, paths: Vec<String>) -> Result<Vec<InspectEntry>, String> {
    let entries = Arc::new(paths);
    let next = AtomicUsize::new(0);
    let results = Mutex::new(
        (0..entries.len())
            .map(|_| None::<InspectEntry>)
            .collect::<Vec<_>>(),
    );
    let failure = Mutex::new(None::<String>);
    thread::scope(|scope| {
        for _ in 0..CONCURRENCY.min(entries.len()) {
            let entries = Arc::clone(&entries);
            let next = &next;
            let results = &results;
            let failure = &failure;
            scope.spawn(move || {
                loop {
                    if failure.lock().unwrap().is_some() {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= entries.len() {
                        break;
                    }
                    match inspect_entry(workspace, entries[index].clone()) {
                        Ok(entry) => results.lock().unwrap()[index] = Some(entry),
                        Err(error) => {
                            let mut guard = failure.lock().unwrap();
                            if guard.is_none() {
                                *guard = Some(error);
                            }
                            break;
                        }
                    }
                }
            });
        }
    });
    if let Some(error) = failure.lock().unwrap().take() {
        return Err(error);
    }
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|entry| entry.ok_or_else(|| "native inspect 结果缺失".into()))
        .collect()
}

#[cfg(unix)]
fn inspect_entry(workspace: &Path, path: String) -> Result<InspectEntry, String> {
    match fs::symlink_metadata(workspace.join(&path)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(InspectEntry {
            path,
            kind: "absent".into(),
            dev: None,
            ino: None,
            mode: None,
            size: None,
            mtime_ns: None,
            ctime_ns: None,
        }),
        Err(error) => Err(format!("inspect 叶子 metadata 失败：{path}: {error}")),
        Ok(metadata) => {
            let kind = if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.file_type().is_file() {
                "file"
            } else {
                "other"
            };
            Ok(InspectEntry {
                path,
                kind: kind.into(),
                dev: Some(metadata.dev().to_string()),
                ino: Some(metadata.ino().to_string()),
                mode: Some(metadata.mode().to_string()),
                size: Some(metadata.size().to_string()),
                mtime_ns: Some(
                    ((metadata.mtime() as i128) * 1_000_000_000 + metadata.mtime_nsec() as i128)
                        .to_string(),
                ),
                ctime_ns: Some(
                    ((metadata.ctime() as i128) * 1_000_000_000 + metadata.ctime_nsec() as i128)
                        .to_string(),
                ),
            })
        }
    }
}

fn load_pack(
    path: &Path,
    op_id: &str,
    plan_digest: &str,
    expected_checksum: &str,
) -> Result<Pack, String> {
    let bytes = fs::read(path).map_err(error("读取 durable pack 失败"))?;
    if sha256(&bytes) != expected_checksum {
        return Err("durable pack 完整 checksum 不匹配".into());
    }
    if bytes.len() < MAGIC.len() + 4 || &bytes[..MAGIC.len()] != MAGIC {
        return Err("durable pack magic 无效".into());
    }
    let header_length =
        u32::from_be_bytes(bytes[MAGIC.len()..MAGIC.len() + 4].try_into().unwrap()) as usize;
    if header_length == 0 || header_length > 16 * 1024 * 1024 {
        return Err("durable pack header length 无效".into());
    }
    let header_start = MAGIC.len() + 4;
    let payload_start = header_start + header_length;
    if payload_start > bytes.len() {
        return Err("durable pack header 被截断".into());
    }
    let header_bytes = &bytes[header_start..payload_start];
    let mut header_value: serde_json::Value = serde_json::from_slice(header_bytes)
        .map_err(|error| format!("解析 durable pack header 失败: {error}"))?;
    let recorded_checksum = header_value
        .as_object_mut()
        .and_then(|object| object.remove("checksum"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or("durable pack header checksum 缺失")?;
    if sha256(canonical_json(&header_value).as_bytes()) != recorded_checksum {
        return Err("durable pack header checksum 不匹配".into());
    }
    let header: PackHeader = serde_json::from_slice(header_bytes)
        .map_err(|error| format!("解析 durable pack header 失败: {error}"))?;
    if header.schema_version != 1
        || header.op_id != op_id
        || header.plan_digest != plan_digest
        || header.checksum != recorded_checksum
    {
        return Err("durable pack identity 不匹配".into());
    }
    let mut entries = BTreeMap::new();
    for entry in header.entries {
        let mut variants = BTreeMap::new();
        for variant in entry.variants {
            if variants
                .insert(variant.fingerprint.clone(), variant)
                .is_some()
            {
                return Err(format!("durable pack variant 重复：{}", entry.path));
            }
        }
        let path = entry.path.clone();
        let packed = PackedOperation {
            source_artifact: entry.source_artifact,
            target_artifact: entry.target_artifact,
            source_fingerprint: entry.source_fingerprint,
            target_fingerprint: entry.target_fingerprint,
            variants,
        };
        if entries.insert(path.clone(), packed).is_some() {
            return Err(format!("durable pack 路径重复：{path}"));
        }
    }
    Ok(Pack {
        bytes,
        payload_start,
        entries,
    })
}

fn verify_source(pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    if entry.source_variant.kind == "absent" {
        return assert_absent(&entry.original, &entry.path);
    }
    verify_file(pack, &entry.original, &entry.source_variant, &entry.path)
}

fn create_target(pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    let Some(target) = entry.target.as_ref() else {
        return Ok(());
    };
    assert_absent(target, &entry.path)?;
    let bytes = read_variant(pack, &entry.target_variant)?;
    let mode = entry
        .target_variant
        .mode
        .ok_or_else(|| format!("target mode 缺失：{}", entry.path))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(mode);
    let mut file = options
        .open(target)
        .map_err(error_path("创建 target artifact 失败", &entry.path))?;
    file.write_all(&bytes)
        .map_err(error_path("写入 target artifact 失败", &entry.path))?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(error_path("设置 target mode 失败", &entry.path))?;
    verify_file(pack, target, &entry.target_variant, &entry.path)
}

fn capture_source(pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    if entry.target.is_none() {
        #[cfg(unix)]
        {
            let parent = entry.parent.as_ref().ok_or("delete parent handle 缺失")?;
            let original_name = entry
                .original_name
                .as_deref()
                .ok_or("delete original name 缺失")?;
            let source_name = entry
                .source_name
                .as_deref()
                .ok_or("delete source name 缺失")?;
            verify_file(pack, &entry.original, &entry.source_variant, &entry.path)?;
            assert_absent(&entry.source, &entry.path)?;
            link_no_replace_at(parent, original_name, source_name, &entry.path)?;
            verify_file(pack, &entry.original, &entry.source_variant, &entry.path)?;
            verify_file(pack, &entry.source, &entry.source_variant, &entry.path)?;
            assert_same_file_identity(&entry.original, &entry.source, &entry.path)?;
            unlink_at(parent, original_name, &entry.path)?;
            assert_absent(&entry.original, &entry.path)?;
            verify_file(pack, &entry.source, &entry.source_variant, &entry.path)?;
            return Ok(());
        }
        #[cfg(not(unix))]
        return Err("当前平台 native delete 不支持，回退 TypeScript restore".into());
    }
    if entry.source_variant.kind == "absent" {
        assert_absent(&entry.original, &entry.path)?;
        assert_absent(&entry.source, &entry.path)?;
        return Ok(());
    }
    verify_file(pack, &entry.original, &entry.source_variant, &entry.path)?;
    rename_no_replace(&entry.original, &entry.source)
        .map_err(error_path("原子隔离 source 失败", &entry.path))?;
    verify_file(pack, &entry.source, &entry.source_variant, &entry.path)
}

fn install_target(pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    if entry.target.is_none() {
        return Ok(());
    }
    assert_absent(&entry.original, &entry.path)?;
    let target = entry.target.as_ref().ok_or("target artifact 缺失")?;
    verify_file(pack, target, &entry.target_variant, &entry.path)?;
    fs::hard_link(target, &entry.original).map_err(error_path(
        "原子 no-clobber target install 失败",
        &entry.path,
    ))
}

fn verify_installed(pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    if entry.target.is_none() {
        assert_absent(&entry.original, &entry.path)?;
        verify_file(pack, &entry.source, &entry.source_variant, &entry.path)?;
        return Ok(());
    }
    verify_file(pack, &entry.original, &entry.target_variant, &entry.path)?;
    assert_same_file_identity(&entry.original, entry.target.as_ref().unwrap(), &entry.path)?;
    if entry.source_variant.kind == "file" {
        verify_file(pack, &entry.source, &entry.source_variant, &entry.path)?;
    } else {
        assert_absent(&entry.source, &entry.path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn open_parent_directory(path: &Path) -> Result<ParentDirectory, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(error("打开 native delete parent 失败"))?;
    Ok(ParentDirectory { file })
}

#[cfg(unix)]
fn link_no_replace_at(
    parent: &ParentDirectory,
    original_name: &str,
    source_name: &str,
    logical: &str,
) -> Result<(), String> {
    let original = CString::new(original_name).map_err(|_| format!("文件名包含 NUL：{logical}"))?;
    let source =
        CString::new(source_name).map_err(|_| format!("source 文件名包含 NUL：{logical}"))?;
    let result = unsafe {
        libc::linkat(
            parent.file.as_raw_fd(),
            original.as_ptr(),
            parent.file.as_raw_fd(),
            source.as_ptr(),
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "建立 source hard link 失败：{logical}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(unix)]
fn unlink_at(parent: &ParentDirectory, name: &str, logical: &str) -> Result<(), String> {
    let name = CString::new(name).map_err(|_| format!("文件名包含 NUL：{logical}"))?;
    let result = unsafe { libc::unlinkat(parent.file.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "删除原路径失败：{logical}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(unix)]
fn assert_same_file_identity(left: &Path, right: &Path, logical: &str) -> Result<(), String> {
    let left_metadata =
        fs::symlink_metadata(left).map_err(error_path("读取 installed identity 失败", logical))?;
    let right_metadata =
        fs::symlink_metadata(right).map_err(error_path("读取 ownership identity 失败", logical))?;
    if !left_metadata.file_type().is_file()
        || !right_metadata.file_type().is_file()
        || left_metadata.dev() != right_metadata.dev()
        || left_metadata.ino() != right_metadata.ino()
    {
        return Err(format!("target ownership identity 冲突：{logical}"));
    }
    Ok(())
}

#[cfg(not(unix))]
fn assert_same_file_identity(_left: &Path, _right: &Path, logical: &str) -> Result<(), String> {
    Err(format!(
        "当前平台不支持 target ownership identity：{logical}"
    ))
}

fn read_variant(pack: &Pack, variant: &PackVariant) -> Result<Vec<u8>, String> {
    if variant.kind != "file" {
        return Err("只有 file variant 包含 bytes".into());
    }
    let offset = variant.offset.ok_or("file variant offset 缺失")? as usize;
    let length = variant.length.ok_or("file variant length 缺失")? as usize;
    let expected = variant
        .data_checksum
        .as_ref()
        .ok_or("file variant checksum 缺失")?;
    let start = pack
        .payload_start
        .checked_add(offset)
        .ok_or("durable pack payload offset 溢出")?;
    let end = start
        .checked_add(length)
        .ok_or("durable pack payload length 溢出")?;
    if end > pack.bytes.len() {
        return Err("durable pack payload 越界".into());
    }
    let bytes = pack.bytes[start..end].to_vec();
    if sha256(&bytes) != *expected {
        return Err("durable pack payload checksum 不匹配".into());
    }
    Ok(bytes)
}

fn verify_file(
    pack: &Pack,
    path: &Path,
    variant: &PackVariant,
    logical: &str,
) -> Result<(), String> {
    if variant.kind != "file" {
        return Err(format!("预期普通文件 variant：{logical}"));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(error_path("读取文件 metadata 失败", logical))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(format!("普通文件类型冲突：{logical}"));
    }
    #[cfg(unix)]
    {
        let observed = if metadata.permissions().mode() & 0o111 == 0 {
            0o644
        } else {
            0o755
        };
        if Some(observed) != variant.mode {
            return Err(format!("普通文件 mode 冲突：{logical}"));
        }
    }
    let expected = variant
        .data_checksum
        .as_ref()
        .ok_or_else(|| format!("file checksum 缺失：{logical}"))?;
    let bytes = read_file_nofollow(path).map_err(error_path("读取普通文件失败", logical))?;
    if sha256(&bytes) != *expected {
        return Err(format!("普通文件内容冲突：{logical}"));
    }
    let _ = pack;
    Ok(())
}

fn read_file_nofollow(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())?;
    let target = CString::new(target.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::hard_link(source, target)?;
    fs::remove_file(source)
}

fn assert_absent(path: &Path, logical: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("检查 absent 失败：{logical}: {error}")),
        Ok(_) => Err(format!("no-clobber 路径已存在：{logical}")),
    }
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("不安全路径：{relative}"));
    }
    let joined = root.join(relative_path);
    let parent = joined
        .parent()
        .ok_or_else(|| format!("路径缺少 parent：{relative}"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(error_path("parent canonicalize 失败", relative))?;
    if !canonical_parent.starts_with(root) {
        return Err(format!("路径逃逸 workspace：{relative}"));
    }
    Ok(joined)
}

fn safe_artifact(root: &Path, path: &str, artifact: &str, role: &str) -> Result<PathBuf, String> {
    let original = Path::new(path);
    let artifact_path = Path::new(artifact);
    if original.parent() != artifact_path.parent() {
        return Err(format!("artifact parent 冲突：{path}"));
    }
    let name = artifact_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("artifact name 无效")?;
    let nonce = name
        .strip_prefix(".pi-undo-q2-")
        .and_then(|value| value.strip_suffix(&format!("-{role}")))
        .ok_or_else(|| format!("artifact name 不受支持：{artifact}"))?;
    if nonce.len() != 32
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("artifact nonce 不受支持：{artifact}"));
    }
    safe_path(root, artifact)
}

fn parallel<F>(entries: &Arc<Vec<OperationEntry>>, operation: F) -> Result<(), String>
where
    F: Fn(&OperationEntry) -> Result<(), String> + Sync,
{
    parallel_with_limit(entries, CONCURRENCY, operation)
}

fn parallel_with_limit<F>(
    entries: &Arc<Vec<OperationEntry>>,
    concurrency: usize,
    operation: F,
) -> Result<(), String>
where
    F: Fn(&OperationEntry) -> Result<(), String> + Sync,
{
    let next = AtomicUsize::new(0);
    let failure = Mutex::new(None::<String>);
    thread::scope(|scope| {
        for _ in 0..concurrency.min(entries.len()) {
            let operation = &operation;
            let entries = Arc::clone(entries);
            let next = &next;
            let failure = &failure;
            scope.spawn(move || {
                loop {
                    if failure.lock().unwrap().is_some() {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= entries.len() {
                        break;
                    }
                    if let Err(error) = operation(&entries[index]) {
                        let mut guard = failure.lock().unwrap();
                        if guard.is_none() {
                            *guard = Some(error);
                        }
                        break;
                    }
                }
            });
        }
    });
    let result = failure.lock().unwrap().take();
    match result {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).expect("JSON string serialization")
        }
        serde_json::Value::Array(values) => {
            let encoded = values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{encoded}]")
        }
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let encoded = keys
                .into_iter()
                .map(|key| {
                    let encoded_key = serde_json::to_string(key).expect("JSON key serialization");
                    format!("{encoded_key}:{}", canonical_json(&values[key]))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{encoded}}}")
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn error(prefix: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{prefix}: {error}")
}

fn error_path<'a>(
    prefix: &'static str,
    path: &'a str,
) -> impl FnOnce(std::io::Error) -> String + 'a {
    move |error| format!("{prefix}: {path}: {error}")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pi-undo-native-inspect-test-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    fn request(root: &Path, paths: &[&str]) -> PathBuf {
        let path = root.join("request.json");
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "workspaceRoot": root,
                "paths": paths,
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }

    #[test]
    fn inspect_preserves_unix_identity_and_absence() {
        let root = fixture();
        fs::write(root.join("a.txt"), b"abc").unwrap();
        let entries = parallel_inspect(&root, vec!["a.txt".into(), "gone.txt".into()]).unwrap();
        assert_eq!(entries[0].kind, "file");
        assert_eq!(entries[0].size.as_deref(), Some("3"));
        assert!(entries[0].dev.as_deref().unwrap().parse::<u64>().unwrap() > 0);
        assert_eq!(entries[1].kind, "absent");
        assert!(entries[1].dev.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inspect_rejects_symlink_parent() {
        let root = fixture();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/a.txt"), b"abc").unwrap();
        symlink(root.join("target"), root.join("link")).unwrap();
        let request_path = request(&root, &["link/a.txt"]);
        let result = run_inspect(&request_path);
        assert!(result.unwrap_err().contains("中间路径是 symlink"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inspect_rejects_unsafe_and_duplicate_paths() {
        let root = fixture();
        let unsafe_request = request(&root, &["../escape"]);
        assert!(
            run_inspect(&unsafe_request)
                .unwrap_err()
                .contains("不安全 inspect 路径")
        );
        let duplicate_request = request(&root, &["a.txt", "a.txt"]);
        assert!(
            run_inspect(&duplicate_request)
                .unwrap_err()
                .contains("inspect 路径重复")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
