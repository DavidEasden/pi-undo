use std::ffi::{CStr, CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

/// 所有相对操作都绑定已打开的目录；中间组件和叶子都不跟随 symlink。
pub(crate) struct Directory {
    pub(crate) file: File,
}

impl Directory {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        Ok(Self { file })
    }

    pub(crate) fn open_child(&self, name: &OsStr) -> io::Result<Self> {
        Ok(Self {
            file: self.open_file(name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?,
        })
    }

    pub(crate) fn open_file(&self, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
        let name = CString::new(name.as_bytes())?;
        let fd = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode as libc::c_uint,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    pub(crate) fn stat(&self, name: &OsStr) -> io::Result<libc::stat> {
        let name = CString::new(name.as_bytes())?;
        let mut metadata = MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            Ok(unsafe { metadata.assume_init() })
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(crate) fn assert_child(&self, name: &OsStr, child: &Directory) -> io::Result<()> {
        let observed = self.stat(name)?;
        let expected = child.file.metadata()?;
        if observed.st_mode & libc::S_IFMT != libc::S_IFDIR
            || observed.st_dev as u64 != expected.dev()
            || observed.st_ino as u64 != expected.ino()
        {
            return Err(io::Error::other("目录身份发生变化"));
        }
        Ok(())
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn entries(&self) -> io::Result<Vec<(String, u8)>> {
        use std::os::fd::IntoRawFd;
        // 独立目录流，避免 dup 共享目录偏移，影响后续复核。
        let fd = self.open_child(OsStr::new("."))?.file.into_raw_fd();
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(error);
        }
        struct Entries(*mut libc::DIR);
        impl Drop for Entries {
            fn drop(&mut self) {
                unsafe { libc::closedir(self.0) };
            }
        }
        let stream = Entries(stream);
        let mut result = Vec::new();
        loop {
            #[cfg(target_os = "macos")]
            let errno = unsafe { libc::__error() };
            #[cfg(target_os = "linux")]
            let errno = unsafe { libc::__errno_location() };
            unsafe { *errno = 0 };
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                if unsafe { *errno } != 0 {
                    return Err(io::Error::last_os_error());
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name = name
                .to_str()
                .map_err(|_| io::Error::other("目录项不是有效 UTF-8"))?;
            result.push((name.to_owned(), unsafe { (*entry).d_type }));
        }
        Ok(result)
    }
}

pub(crate) fn same_directory(left: &Metadata, right: &Metadata) -> bool {
    left.is_dir() && right.is_dir() && left.dev() == right.dev() && left.ino() == right.ino()
}
