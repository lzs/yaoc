//! Acquire before any profile, WebView or shell initialization.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
};

#[cfg(windows)]
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Arc,
};

pub struct Instance {
    _lock: File,
    #[cfg(windows)]
    event: Arc<OwnedHandle>,
}
pub fn acquire() -> Result<Option<Instance>, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("LOCALAPPDATA must be an absolute directory")?
        .join("io.github.lzs.yaoc");
    acquire_at(root)
}
fn acquire_at(root: PathBuf) -> Result<Option<Instance>, String> {
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("instance.lock"))
        .map_err(|e| format!("Cannot open instance lock: {e}"))?;
    let digest = hex::encode(Sha256::digest(
        root.to_string_lossy().to_lowercase().as_bytes(),
    ));
    #[cfg(windows)]
    let event = unsafe {
        let name: Vec<u16> = format!("Global\\YAOC-{digest}-activate")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let event = CreateEventW(std::ptr::null(), 0, 0, name.as_ptr());
        if event.is_null() {
            return Err("Cannot create YAOC activation event".into());
        }
        Arc::new(OwnedHandle::from_raw_handle(event))
    };
    #[cfg(not(windows))]
    let _ = digest;
    match lock.try_lock() {
        Ok(()) => {
            use std::io::Write;
            lock.set_len(0).map_err(|e| e.to_string())?;
            write!(lock, "{}", std::process::id()).map_err(|e| e.to_string())?;
            lock.sync_all().map_err(|e| e.to_string())?;
            std::fs::write(root.join("instance.pid"), std::process::id().to_string())
                .map_err(|e| e.to_string())?;
            Ok(Some(Instance {
                _lock: lock,
                #[cfg(windows)]
                event,
            }))
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            #[cfg(windows)]
            unsafe {
                if let Ok(pid) = std::fs::read_to_string(root.join("instance.pid"))
                    .unwrap_or_default()
                    .parse::<u32>()
                {
                    AllowSetForegroundWindow(pid);
                }
                SetEvent(event.as_raw_handle());
            }
            Ok(None)
        }
        Err(e) => Err(format!("Cannot lock YAOC user profile: {e}")),
    }
}
impl Instance {
    pub fn listen(&self, app: tauri::AppHandle) {
        #[cfg(windows)]
        {
            use tauri::Manager;
            let event = self.event.clone();
            std::thread::spawn(move || loop {
                let result = unsafe { WaitForSingleObject(event.as_raw_handle(), u32::MAX) };
                if result == u32::MAX {
                    break;
                }
                if result == 0 {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            });
        }
        #[cfg(not(windows))]
        let _ = app;
    }
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateEventW(
        attributes: *const std::ffi::c_void,
        manual: i32,
        initial: i32,
        name: *const u16,
    ) -> *mut std::ffi::c_void;
    fn SetEvent(event: *mut std::ffi::c_void) -> i32;
    fn WaitForSingleObject(handle: *mut std::ffi::c_void, timeout: u32) -> u32;
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn AllowSetForegroundWindow(pid: u32) -> i32;
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_lock_excludes_another_copy_and_releases() {
        let root = tempfile::tempdir().unwrap();
        let first = super::acquire_at(root.path().to_path_buf())
            .unwrap()
            .unwrap();
        assert!(super::acquire_at(root.path().to_path_buf())
            .unwrap()
            .is_none());
        drop(first);
        assert!(super::acquire_at(root.path().to_path_buf())
            .unwrap()
            .is_some());
    }
}
