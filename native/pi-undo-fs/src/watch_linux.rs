//! Linux 常驻扫描的 inotify 监听实现。
//!
//! 语义与 macOS FSEvents 版本一致：事件只用于让目录缓存失效；
//! 队列溢出、监听数超限、根目录移动/卸载或无法解析的事件都会标记 uncertain，触发完整重扫。
//! 事件在调用 drain 的线程中以非阻塞方式读取，新目录的 watch 在读到创建事件时立即补齐，
//! 补齐后到扫描之间发生的变化由 serve 的 late drain 覆盖。

use super::{EventBatch, HashSet};
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const MAX_CHANGED_PATHS: usize = 8192;
const MAX_DEPTH: usize = 128;
const WATCH_MASK: u32 = libc::IN_CREATE
    | libc::IN_DELETE
    | libc::IN_MOVED_FROM
    | libc::IN_MOVED_TO
    | libc::IN_ATTRIB
    | libc::IN_DELETE_SELF
    | libc::IN_MOVE_SELF
    | libc::IN_ONLYDIR
    | libc::IN_DONT_FOLLOW
    | libc::IN_EXCL_UNLINK;

struct Inner {
    fd: i32,
    workspace: PathBuf,
    by_wd: HashMap<i32, String>,
    by_path: HashMap<String, i32>,
    generation: u64,
    /// watch 数超限等不可恢复状态：之后每次 drain 都要求完整重扫。
    degraded: bool,
    pending: EventBatch,
}

pub(super) struct Watch {
    inner: RefCell<Inner>,
}

fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_owned() } else { format!("{parent}/{name}") }
}

fn parent_of(path: &str) -> String {
    path.rfind('/').map(|index| path[..index].to_owned()).unwrap_or_default()
}

fn insert_changed(batch: &mut EventBatch, path: String) {
    if batch.uncertain {
        return;
    }
    if batch.changed_paths.len() >= MAX_CHANGED_PATHS && !batch.changed_paths.contains(&path) {
        batch.uncertain = true;
        batch.changed_paths.clear();
        return;
    }
    batch.changed_paths.insert(path);
}

impl Inner {
    fn add_one(&mut self, relative: &str) -> Result<(), i32> {
        let absolute = if relative.is_empty() { self.workspace.clone() } else { self.workspace.join(relative) };
        let path_c = CString::new(absolute.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
        let wd = unsafe { libc::inotify_add_watch(self.fd, path_c.as_ptr(), WATCH_MASK) };
        if wd < 0 {
            return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO));
        }
        if let Some(existing) = self.by_wd.insert(wd, relative.to_owned()) {
            // 同一 inode 已在其他路径下被监听（如 bind mount）：路径归属不再可信。
            if existing != relative {
                self.by_path.remove(&existing);
                self.degraded = true;
                self.pending.uncertain = true;
            }
        }
        self.by_path.insert(relative.to_owned(), wd);
        Ok(())
    }

    /// 递归为目录子树补齐 watch，并把新加入的目录全部记为变化。
    /// 目录在枚举时消失属于正常竞争，由父目录事件覆盖；其他失败降级为完整重扫。
    fn add_tree(&mut self, relative: &str, depth: usize, record: bool) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err("目录监听深度超过限制".into());
        }
        match self.add_one(relative) {
            Ok(()) => {}
            Err(code) if code == libc::ENOENT || code == libc::ENOTDIR => return Ok(()),
            Err(code) if code == libc::ENOSPC => {
                return Err("inotify watch 数量超过 fs.inotify.max_user_watches".into());
            }
            Err(code) => return Err(format!("inotify_add_watch 失败：errno {code}")),
        }
        if record {
            insert_changed(&mut self.pending, relative.to_owned());
        }
        let absolute = if relative.is_empty() { self.workspace.clone() } else { self.workspace.join(relative) };
        let entries = match std::fs::read_dir(&absolute) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            // DirEntry::file_type 不跟随符号链接，与扫描器的 O_NOFOLLOW 语义一致。
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if !kind.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Err("目录监听遇到非 UTF-8 路径".into());
            };
            if name == ".git" {
                continue;
            }
            self.add_tree(&join(relative, &name), depth + 1, record)?;
        }
        Ok(())
    }

    fn remove_tree(&mut self, relative: &str) {
        let prefix = format!("{relative}/");
        let doomed: Vec<String> = self
            .by_path
            .keys()
            .filter(|path| path.as_str() == relative || path.starts_with(&prefix))
            .cloned()
            .collect();
        for path in doomed {
            if let Some(wd) = self.by_path.remove(&path) {
                self.by_wd.remove(&wd);
                unsafe { libc::inotify_rm_watch(self.fd, wd) };
            }
        }
    }

    /// 非阻塞读取内核队列中的全部事件并合并进 pending。
    fn read_events(&mut self) {
        #[repr(C, align(8))]
        struct Buffer([u8; 64 * 1024]);
        let mut buffer = Buffer([0; 64 * 1024]);
        loop {
            let read = unsafe {
                libc::read(self.fd, buffer.0.as_mut_ptr() as *mut libc::c_void, buffer.0.len())
            };
            if read < 0 {
                let error = std::io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EAGAIN) => return,
                    Some(libc::EINTR) => continue,
                    _ => {
                        self.degraded = true;
                        return;
                    }
                }
            }
            if read == 0 {
                self.degraded = true;
                return;
            }
            let bytes = &buffer.0[..read as usize];
            let header = std::mem::size_of::<libc::inotify_event>();
            let mut offset = 0;
            while offset + header <= bytes.len() {
                let event = unsafe {
                    std::ptr::read_unaligned(bytes[offset..].as_ptr() as *const libc::inotify_event)
                };
                let name_end = offset + header + event.len as usize;
                if name_end > bytes.len() {
                    self.degraded = true;
                    return;
                }
                let raw = &bytes[offset + header..name_end];
                let name = &raw[..raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len())];
                self.generation = self.generation.wrapping_add(1);
                self.handle(event.wd, event.mask, name);
                offset = name_end;
            }
        }
    }

    fn handle(&mut self, wd: i32, mask: u32, name: &[u8]) {
        if mask & (libc::IN_Q_OVERFLOW | libc::IN_UNMOUNT) != 0 {
            // 丢失创建事件也会丢失新目录的 watch；一次重扫无法修补监听覆盖。
            // 本进程持续报告不确定，让客户端丢弃进程并重新建立整棵树的监听。
            self.degraded = true;
            self.pending.uncertain = true;
            return;
        }
        if mask & libc::IN_IGNORED != 0 {
            if let Some(path) = self.by_wd.remove(&wd) {
                if self.by_path.get(&path) == Some(&wd) {
                    self.by_path.remove(&path);
                }
                // 正常 remove_tree 已先删除映射；仍有映射说明监听意外消失。
                self.degraded = true;
            }
            return;
        }
        let Some(directory) = self.by_wd.get(&wd).cloned() else {
            // 已移除 watch 的残留事件：父目录事件已覆盖对应变化。
            return;
        };
        if mask & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF) != 0 {
            if directory.is_empty() {
                self.degraded = true;
            } else {
                insert_changed(&mut self.pending, parent_of(&directory));
                if mask & libc::IN_DELETE_SELF != 0 {
                    // 已知的删除先移除映射，随后 IN_IGNORED 不属于意外监听丢失。
                    self.remove_tree(&directory);
                }
            }
            return;
        }
        if name.is_empty() {
            // 目录自身属性变化（权限、时间戳）：重新核验该目录。
            insert_changed(&mut self.pending, directory);
            return;
        }
        let Some(name) = std::str::from_utf8(name).ok() else {
            self.degraded = true;
            self.pending.uncertain = true;
            return;
        };
        let child = join(&directory, name);
        let is_directory = mask & libc::IN_ISDIR != 0;
        if is_directory && name != ".git" {
            if mask & (libc::IN_DELETE | libc::IN_MOVED_FROM) != 0 {
                self.remove_tree(&child);
            }
            if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                // 移入的目录可能已有子树，需要递归补齐 watch。
                if let Err(_) = self.add_tree(&child, child.matches('/').count() + 1, true) {
                    self.degraded = true;
                }
            }
            if mask & libc::IN_ATTRIB != 0 {
                insert_changed(&mut self.pending, child);
            }
            if mask & (libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_MOVED_TO) != 0 {
                insert_changed(&mut self.pending, directory);
            }
            return;
        }
        // 文件、符号链接或 .git：只影响父目录的子项列表和 has_git。
        if mask & (libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_MOVED_TO) != 0 {
            insert_changed(&mut self.pending, directory);
        }
    }
}

impl Watch {
    pub(super) fn create(workspace: &Path) -> Result<Self, String> {
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(format!("inotify_init1 失败：{}", std::io::Error::last_os_error()));
        }
        let mut inner = Inner {
            fd,
            workspace: workspace.to_path_buf(),
            by_wd: HashMap::new(),
            by_path: HashMap::new(),
            generation: 0,
            degraded: false,
            pending: EventBatch { generation: 0, changed_paths: HashSet::new(), uncertain: false, file_entries_only: false, coverage_trusted: false },
        };
        // 初始 watch 建立失败（如超过 max_user_watches）时拒绝常驻模式，调用方回退一次性扫描。
        if let Err(error) = inner.add_tree("", 0, false) {
            unsafe { libc::close(fd) };
            return Err(error);
        }
        if !inner.by_path.contains_key("") {
            unsafe { libc::close(fd) };
            return Err("无法监听 workspace 根目录".into());
        }
        Ok(Self { inner: RefCell::new(inner) })
    }

    pub(super) fn drain(&self, settle: bool) -> EventBatch {
        if settle {
            // inotify 事件同步入队，短暂等待只用于吸收正在进行的写入。
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let mut inner = self.inner.borrow_mut();
        inner.read_events();
        if inner.degraded {
            return EventBatch::unknown();
        }
        let generation = inner.generation;
        let changed_paths = std::mem::take(&mut inner.pending.changed_paths);
        let uncertain = std::mem::replace(&mut inner.pending.uncertain, false);
        EventBatch { generation, changed_paths, uncertain, file_entries_only: false, coverage_trusted: false }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        unsafe { libc::close(self.inner.get_mut().fd) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pi-undo-inotify-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(root).unwrap()
    }

    #[test]
    fn lost_watch_coverage_never_becomes_a_quiet_cache_hit() {
        let root = temp_root("overflow");
        std::fs::create_dir_all(root.join("old")).unwrap();
        let watch = Watch::create(&root).unwrap();
        watch.drain(true);
        watch.inner.borrow_mut().handle(-1, libc::IN_Q_OVERFLOW, b"");
        // 即使队列已排空，丢失的新目录 watch 也不会凭空恢复。
        assert!(watch.drain(true).uncertain);
        assert!(watch.drain(true).uncertain);
        drop(watch);
        assert!(!Watch::create(&root).unwrap().drain(true).uncertain);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unexpected_watch_removal_stays_uncertain() {
        let root = temp_root("lost-watch");
        std::fs::create_dir_all(root.join("child")).unwrap();
        let watch = Watch::create(&root).unwrap();
        watch.drain(true);
        let wd = watch.inner.borrow().by_path["child"];
        watch.inner.borrow_mut().handle(wd, libc::IN_IGNORED, b"");
        assert!(watch.drain(true).uncertain);
        assert!(watch.drain(true).uncertain);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quiet_workspace_reports_no_changes() {
        let root = temp_root("quiet");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        let watch = Watch::create(&root).unwrap();
        let batch = watch.drain(true);
        assert!(!batch.uncertain);
        assert!(batch.changed_paths.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_and_new_directories_invalidate_parents() {
        let root = temp_root("nested");
        std::fs::create_dir_all(root.join("repo/src")).unwrap();
        let watch = Watch::create(&root).unwrap();
        std::fs::write(root.join("repo/src/main.rs"), "x").unwrap();
        std::fs::create_dir_all(root.join("repo/new/deep")).unwrap();
        let batch = watch.drain(true);
        assert!(!batch.uncertain);
        assert!(batch.changed_paths.contains("repo/src"));
        assert!(batch.changed_paths.contains("repo"));
        assert!(batch.changed_paths.contains("repo/new"));
        // 新目录的 watch 已补齐：其下后续变化也能观测到。
        std::fs::create_dir(root.join("repo/new/deep/.git")).unwrap();
        let batch = watch.drain(true);
        assert!(batch.changed_paths.contains("repo/new/deep"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moved_out_directories_are_forgotten_and_root_loss_is_uncertain() {
        let root = temp_root("moved");
        let outside = temp_root("moved-outside");
        std::fs::create_dir_all(root.join("pkg/inner")).unwrap();
        let watch = Watch::create(&root).unwrap();
        std::fs::rename(root.join("pkg"), outside.join("pkg")).unwrap();
        let batch = watch.drain(true);
        assert!(batch.changed_paths.contains(""));
        // 移出后的变化不再归属到 workspace。
        std::fs::create_dir(outside.join("pkg/inner/x")).unwrap();
        assert!(watch.drain(true).changed_paths.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
        assert!(watch.drain(true).uncertain);
        std::fs::remove_dir_all(outside).unwrap();
    }
}
