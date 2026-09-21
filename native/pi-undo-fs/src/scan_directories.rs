use crate::directory::{Directory, same_directory};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u32,
    workspace_root: String,
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
    if request.schema_version != 1 {
        return Err("目录扫描 schemaVersion 不受支持".into());
    }
    let workspace = Path::new(&request.workspace_root);
    if fs::canonicalize(workspace).map_err(|error| error.to_string())? != workspace {
        return Err("workspaceRoot 必须是 canonical path".into());
    }
    let root = Directory::open(workspace).map_err(|error| error.to_string())?;
    let mut response = Response {
        ok: true,
        directories: 0,
        repositories: Vec::new(),
    };
    match scan(&root, "", 0, &mut response) {
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
) -> std::io::Result<()> {
    if depth > 128 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "目录扫描深度超过限制",
        ));
    }
    let before = directory.file.metadata()?;
    let entries = directory.entries()?;
    response.directories += 1;
    if !path.is_empty()
        && entries
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(".git"))
    {
        response.repositories.push(Repository {
            path: path.into(),
            dev: before.dev().to_string(),
            ino: before.ino().to_string(),
        });
    }
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
        let child = directory.open_child(name_os)?;
        let child_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        scan(&child, &child_path, depth + 1, response)?;
        directory.assert_child(name_os, &child)?;
    }
    let after = directory.file.metadata()?;
    // 不缓存目录结果；扫描期间的增删、替换必须显式失败，不能漏掉新仓库。
    if before.mtime() != after.mtime()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

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
        scan(&Directory::open(&root).unwrap(), "", 0, &mut response).unwrap();
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
