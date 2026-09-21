use crate::directory::{Directory, same_directory};
use crate::{OperationEntry, Pack, PackVariant, read_variant, sha256};
use std::collections::BTreeMap;
use std::ffi::{CString, OsStr};
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) struct ParentDirectory {
    pub(crate) directory: Directory,
    path: PathBuf,
    parent: Option<Arc<ParentDirectory>>,
}

impl ParentDirectory {
    pub(crate) fn root(path: &Path) -> Result<Arc<Self>, String> {
        let result = Arc::new(Self {
            directory: Directory::open(path).map_err(|error| error.to_string())?,
            path: path.into(),
            parent: None,
        });
        result.assert_bound()?;
        Ok(result)
    }

    pub(crate) fn assert_bound(&self) -> Result<(), String> {
        if let Some(parent) = &self.parent {
            parent.assert_bound()?;
            parent
                .directory
                .assert_child(self.path.file_name().unwrap(), &self.directory)
                .map_err(|error| {
                    format!("native 父目录绑定变化：{}: {error}", self.path.display())
                })?;
        } else if fs::canonicalize(&self.path).map_err(|error| error.to_string())? != self.path
            || !same_directory(
                &fs::symlink_metadata(&self.path).map_err(|error| error.to_string())?,
                &self
                    .directory
                    .file
                    .metadata()
                    .map_err(|error| error.to_string())?,
            )
        {
            return Err("native workspace 目录身份变化".into());
        }
        Ok(())
    }
}

pub(crate) fn open_parent(
    root: &Arc<ParentDirectory>,
    path: &str,
    parents: &mut BTreeMap<PathBuf, Arc<ParentDirectory>>,
) -> Result<Arc<ParentDirectory>, String> {
    let mut current = Arc::clone(root);
    let mut relative = PathBuf::new();
    for component in Path::new(path).parent().unwrap().components() {
        relative.push(component);
        if let Some(parent) = parents.get(&relative) {
            current = Arc::clone(parent);
            continue;
        }
        if parents.len() >= 128 {
            return Err("native 父目录句柄数量超过限制".into());
        }
        let directory = current
            .directory
            .open_child(component.as_os_str())
            .map_err(|error| format!("打开 native 父目录失败：{}: {error}", relative.display()))?;
        current
            .directory
            .assert_child(component.as_os_str(), &directory)
            .map_err(|error| error.to_string())?;
        current = Arc::new(ParentDirectory {
            directory,
            path: root.path.join(&relative),
            parent: Some(current),
        });
        parents.insert(relative.clone(), Arc::clone(&current));
    }
    Ok(current)
}

fn names(entry: &OperationEntry) -> Result<(&ParentDirectory, &OsStr, &OsStr), String> {
    let parent = entry.parent.as_deref().ok_or("native parent handle 缺失")?;
    let original = entry.original.file_name().ok_or("native 文件名缺失")?;
    let source = entry.source.file_name().ok_or("native source 文件名缺失")?;
    parent
        .assert_bound()
        .map_err(|error| format!("{}: {error}", entry.path))?;
    Ok((parent, original, source))
}

fn absent(parent: &ParentDirectory, name: &OsStr) -> Result<(), String> {
    match parent.directory.stat(name) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(_) => Err(format!("no-clobber 路径已存在：{}", name.to_string_lossy())),
    }
}

fn verify_file(
    parent: &ParentDirectory,
    name: &OsStr,
    variant: &PackVariant,
) -> Result<(), String> {
    let mut file = parent
        .directory
        .open_file(name, libc::O_RDONLY | libc::O_NONBLOCK, 0)
        .map_err(|error| format!("读取普通文件失败：{}: {error}", name.to_string_lossy()))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || variant.kind != "file" {
        return Err("native 普通文件类型冲突".into());
    }
    let mode = if metadata.mode() & 0o111 == 0 {
        0o644
    } else {
        0o755
    };
    if Some(mode) != variant.mode {
        return Err("native 普通文件 mode 冲突".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if Some(sha256(&bytes)).as_ref() != variant.data_checksum.as_ref() {
        return Err("native 普通文件内容冲突".into());
    }
    let linked = parent
        .directory
        .stat(name)
        .map_err(|error| error.to_string())?;
    if linked.st_mode & libc::S_IFMT != libc::S_IFREG
        || linked.st_dev as u64 != metadata.dev()
        || linked.st_ino as u64 != metadata.ino()
    {
        return Err("native 普通文件读取期间身份变化".into());
    }
    Ok(())
}

fn same_file(parent: &ParentDirectory, left: &OsStr, right: &OsStr) -> Result<(), String> {
    let left = parent
        .directory
        .stat(left)
        .map_err(|error| error.to_string())?;
    let right = parent
        .directory
        .stat(right)
        .map_err(|error| error.to_string())?;
    if left.st_mode & libc::S_IFMT != libc::S_IFREG
        || right.st_mode & libc::S_IFMT != libc::S_IFREG
        || left.st_dev != right.st_dev
        || left.st_ino != right.st_ino
    {
        return Err("native ownership identity 冲突".into());
    }
    Ok(())
}

fn link(parent: &ParentDirectory, source: &OsStr, target: &OsStr) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_bytes()).map_err(|error| error.to_string())?;
    let target = CString::new(target.as_bytes()).map_err(|error| error.to_string())?;
    let fd = parent.directory.file.as_raw_fd();
    if unsafe { libc::linkat(fd, source.as_ptr(), fd, target.as_ptr(), 0) } != 0 {
        return Err(format!(
            "native no-clobber link 失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn unlink(parent: &ParentDirectory, name: &OsStr) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(name.as_bytes()).map_err(|error| error.to_string())?;
    if unsafe { libc::unlinkat(parent.directory.file.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(format!(
            "native unlink 失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn rename(parent: &ParentDirectory, source: &OsStr, target: &OsStr) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let source_name = CString::new(source.as_bytes()).map_err(|error| error.to_string())?;
    let target_name = CString::new(target.as_bytes()).map_err(|error| error.to_string())?;
    let fd = parent.directory.file.as_raw_fd();
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            fd,
            source_name.as_ptr(),
            fd,
            target_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            fd,
            source_name.as_ptr(),
            fd,
            target_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (source_name, target_name, fd);
        link(parent, source, target)?;
        return unlink(parent, source);
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if result != 0 {
        return Err(format!(
            "native no-clobber rename 失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub(crate) fn verify_source(_pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    let (parent, original, _) = names(entry)?;
    if entry.source_variant.kind == "absent" {
        absent(parent, original)
    } else {
        verify_file(parent, original, &entry.source_variant)
    }
}

pub(crate) fn create_target(pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    let (parent, _, _) = names(entry)?;
    let Some(target) = &entry.target else {
        return Ok(());
    };
    let name = target.file_name().ok_or("native target 文件名缺失")?;
    let bytes = read_variant(pack, &entry.target_variant)?;
    let mode = entry.target_variant.mode.ok_or("native target mode 缺失")?;
    let mut file = parent
        .directory
        .open_file(name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, mode)
        .map_err(|error| format!("创建 target artifact 失败：{error}"))?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|error| error.to_string())?;
    verify_file(parent, name, &entry.target_variant)
}

pub(crate) fn capture_source(_pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    let (parent, original, source) = names(entry)?;
    absent(parent, source)?;
    if entry.source_variant.kind == "absent" {
        return absent(parent, original);
    }
    verify_file(parent, original, &entry.source_variant)?;
    if entry.target.is_none() {
        link(parent, original, source)?;
        verify_file(parent, original, &entry.source_variant)?;
        verify_file(parent, source, &entry.source_variant)?;
        same_file(parent, original, source)?;
        parent.assert_bound()?;
        unlink(parent, original)?;
        absent(parent, original)?;
    } else {
        rename(parent, original, source)?;
    }
    verify_file(parent, source, &entry.source_variant)
}

pub(crate) fn install_target(_pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    let (parent, original, _) = names(entry)?;
    let Some(target) = &entry.target else {
        return Ok(());
    };
    let target = target.file_name().ok_or("native target 文件名缺失")?;
    absent(parent, original)?;
    verify_file(parent, target, &entry.target_variant)?;
    link(parent, target, original)
}

pub(crate) fn verify_installed(_pack: &Pack, entry: &OperationEntry) -> Result<(), String> {
    let (parent, original, source) = names(entry)?;
    if let Some(target) = &entry.target {
        verify_file(parent, original, &entry.target_variant)?;
        same_file(
            parent,
            original,
            target.file_name().ok_or("native target 文件名缺失")?,
        )?;
    } else {
        absent(parent, original)?;
    }
    if entry.source_variant.kind == "file" {
        verify_file(parent, source, &entry.source_variant)?;
    } else {
        absent(parent, source)?;
    }
    parent.assert_bound()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn bound_parent_rejects_ancestor_replacement() {
        let root = crate::tests::fixture();
        let outside = crate::tests::fixture();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir(outside.join("deep")).unwrap();
        fs::write(root.join("src/deep/a.txt"), b"inside").unwrap();
        fs::write(outside.join("deep/a.txt"), b"outside").unwrap();
        let parent = open_parent(
            &ParentDirectory::root(&root).unwrap(),
            "src/deep/a.txt",
            &mut BTreeMap::new(),
        )
        .unwrap();
        fs::rename(root.join("src"), root.join("moved")).unwrap();
        symlink(&outside, root.join("src")).unwrap();
        assert!(parent.assert_bound().is_err());
        assert_eq!(fs::read(outside.join("deep/a.txt")).unwrap(), b"outside");
        assert_eq!(fs::read(root.join("moved/deep/a.txt")).unwrap(), b"inside");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn parent_handle_limit_accepts_128_and_rejects_129() {
        let root = crate::tests::fixture();
        let parent = ParentDirectory::root(&root).unwrap();
        let mut parents = BTreeMap::new();
        for index in 0..129 {
            fs::create_dir(root.join(format!("d{index}"))).unwrap();
            let result = open_parent(&parent, &format!("d{index}/a.txt"), &mut parents);
            if index < 128 {
                assert!(result.is_ok());
            } else {
                assert!(result.err().unwrap().contains("句柄数量超过限制"));
            }
        }
        assert_eq!(parents.len(), 128);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_clobber_primitives_preserve_existing_artifacts() {
        let root = crate::tests::fixture();
        fs::write(root.join("original"), b"original").unwrap();
        fs::write(root.join("artifact"), b"foreign").unwrap();
        let parent = ParentDirectory::root(&root).unwrap();
        assert!(link(&parent, OsStr::new("original"), OsStr::new("artifact")).is_err());
        assert!(rename(&parent, OsStr::new("original"), OsStr::new("artifact")).is_err());
        assert_eq!(fs::read(root.join("original")).unwrap(), b"original");
        assert_eq!(fs::read(root.join("artifact")).unwrap(), b"foreign");
        fs::remove_dir_all(root).unwrap();
    }
}
