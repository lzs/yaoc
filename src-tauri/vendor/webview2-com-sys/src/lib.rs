#[allow(
    non_snake_case,
    non_upper_case_globals,
    non_camel_case_types,
    dead_code,
    clippy::all
)]
pub mod Microsoft {
    pub mod Web {
        pub mod WebView2 {
            pub mod Win32 {
                mod windows_core {
                    macro_rules! link_webview2 {
                        ($library:literal $abi:literal fn $($function:tt)*) => (
                            extern $abi {
                                pub fn $($function)*;
                            }
                        )
                    }

                    pub(crate) use ::windows_core::*;
                    pub(crate) use link_webview2 as link;
                }

                include!("bindings.rs");
            }
        }
    }
}

pub mod declared_interfaces;

mod embedded_loader {
    use core::ffi::c_void;
    use std::sync::OnceLock;
    use windows_core::{HRESULT, PCWSTR, PWSTR};

    #[cfg(target_arch = "x86_64")]
    static LOADER_BYTES: &[u8] = include_bytes!("../x64/WebView2Loader.dll");
    #[cfg(target_arch = "x86_64")]
    const ARCH_NAME: &str = "x64";

    #[cfg(target_arch = "aarch64")]
    static LOADER_BYTES: &[u8] = include_bytes!("../arm64/WebView2Loader.dll");
    #[cfg(target_arch = "aarch64")]
    const ARCH_NAME: &str = "arm64";

    #[cfg(target_arch = "x86")]
    static LOADER_BYTES: &[u8] = include_bytes!("../x86/WebView2Loader.dll");
    #[cfg(target_arch = "x86")]
    const ARCH_NAME: &str = "x86";

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(lpLibFileName: *const u16, hFile: *mut c_void, dwFlags: u32) -> *mut c_void;
        fn GetProcAddress(hModule: *mut c_void, lpProcName: *const u8) -> *mut c_void;
    }

    static MODULE_HANDLE: OnceLock<(usize, Option<std::fs::File>)> = OnceLock::new();
    static FALLBACK_USERDATA_DIR: OnceLock<(std::path::PathBuf, Option<std::fs::File>)> =
        OnceLock::new();

    pub(super) fn prune_stale_loader_dirs(root: &std::path::Path) {
        let Ok(entries) = std::fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        }
    }

    fn prune_stale_fallback_userdata_dirs(base_dir: &std::path::Path) {
        use std::os::windows::fs::OpenOptionsExt;
        let Ok(entries) = std::fs::read_dir(base_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with("EBWebView-") {
                continue;
            }
            let instance_lock = path.join(".instance.lock");
            if instance_lock.exists() {
                let Ok(lock_handle) = std::fs::OpenOptions::new()
                    .write(true)
                    .share_mode(0)
                    .open(&instance_lock)
                else {
                    continue;
                };
                drop(lock_handle);
            }
            let wv_lock = path.join("EBWebView").join("lockfile");
            if wv_lock.exists()
                && std::fs::OpenOptions::new()
                    .write(true)
                    .open(&wv_lock)
                    .is_err()
            {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        }
    }

    fn get_proc(name: &[u8]) -> Option<*mut c_void> {
        let (hmod, _) = MODULE_HANDLE.get_or_init(|| {
            use std::hash::{BuildHasher, Hasher};
            use std::io::Write;
            use std::os::windows::ffi::OsStrExt;
            use std::os::windows::fs::OpenOptionsExt;
            // A private per-process directory prevents reuse of an attacker-planted cache.
            let root = std::env::var_os("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("yaoc")
                .join("WebView2Loader");
            if std::fs::create_dir_all(&root).is_err() {
                return (0, None);
            }
            prune_stale_loader_dirs(&root);
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u32(std::process::id());
            let dir = root.join(format!("{}-{:016x}", std::process::id(), hasher.finish()));
            if std::fs::create_dir(&dir).is_err() {
                return (0, None);
            }
            let dll_path = dir.join(format!("WebView2Loader-{ARCH_NAME}.dll"));
            let written = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&dll_path)?;
                file.write_all(LOADER_BYTES)?;
                file.sync_all()
            })();
            if written.is_err() {
                return (0, None);
            }
            // Keep the read-locked handle open for the process lifetime to deny concurrent writes/deletion.
            let Ok(mut locked) = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&dll_path)
            else {
                return (0, None);
            };
            if locked
                .metadata()
                .map(|info| info.len() != LOADER_BYTES.len() as u64)
                .unwrap_or(true)
            {
                return (0, None);
            }
            let mut bytes = Vec::with_capacity(LOADER_BYTES.len());
            if std::io::Read::read_to_end(&mut locked, &mut bytes).is_err() || bytes != LOADER_BYTES
            {
                return (0, None);
            }
            let wide: Vec<u16> = dll_path.as_os_str().encode_wide().chain(Some(0)).collect();
            // Search this DLL's directory and System32, never the current working directory.
            let handle = unsafe {
                LoadLibraryExW(
                    wide.as_ptr(),
                    std::ptr::null_mut(),
                    0x00000100 | 0x00000800,
                ) as usize
            };
            (handle, Some(locked))
        });
        if *hmod == 0 {
            return None;
        }
        let ptr = unsafe { GetProcAddress(*hmod as *mut c_void, name.as_ptr()) };
        if ptr.is_null() {
            None
        } else {
            Some(ptr)
        }
    }

    #[cfg(test)]
    pub(super) fn test_export(name: &[u8]) -> bool { get_proc(name).is_some() }

    #[no_mangle]
    pub unsafe extern "system" fn CompareBrowserVersions(
        version1: PCWSTR,
        version2: PCWSTR,
        result: *mut i32,
    ) -> HRESULT {
        type FnType = unsafe extern "system" fn(PCWSTR, PCWSTR, *mut i32) -> HRESULT;
        if let Some(p) = get_proc(b"CompareBrowserVersions\0") {
            let f: FnType = core::mem::transmute(p);
            f(version1, version2, result)
        } else {
            HRESULT(-2147467259)
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn CreateCoreWebView2Environment(
        environmentcreatedhandler: *mut c_void,
    ) -> HRESULT {
        type FnType = unsafe extern "system" fn(*mut c_void) -> HRESULT;
        if let Some(p) = get_proc(b"CreateCoreWebView2Environment\0") {
            let f: FnType = core::mem::transmute(p);
            f(environmentcreatedhandler)
        } else {
            HRESULT(-2147467259)
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn CreateCoreWebView2EnvironmentWithOptions(
        browserexecutablefolder: PCWSTR,
        userdatafolder: PCWSTR,
        environmentoptions: *mut c_void,
        environmentcreatedhandler: *mut c_void,
    ) -> HRESULT {
        type FnType =
            unsafe extern "system" fn(PCWSTR, PCWSTR, *mut c_void, *mut c_void) -> HRESULT;
        if let Some(p) = get_proc(b"CreateCoreWebView2EnvironmentWithOptions\0") {
            let f: FnType = core::mem::transmute(p);

            // Check if the default EBWebView lockfile is currently locked by another instance
            let base_dir = std::env::var_os("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("io.github.lzs.yaoc");
            prune_stale_fallback_userdata_dirs(&base_dir);
            let lock_file = base_dir.join("EBWebView").join("lockfile");
            let is_locked = if lock_file.exists() {
                std::fs::OpenOptions::new().write(true).open(&lock_file).is_err()
            } else {
                false
            };

            if !is_locked {
                let hr = f(
                    browserexecutablefolder,
                    userdatafolder,
                    environmentoptions,
                    environmentcreatedhandler,
                );
                if hr.0 != (0x800700AAu32 as i32) {
                    return hr;
                }
            }

            // Fallback to a per-process unique userdatafolder so concurrent instances never collide via PID reuse
            let (fallback_dir, _) = FALLBACK_USERDATA_DIR.get_or_init(|| {
                use std::hash::{BuildHasher, Hasher};
                use std::os::windows::fs::OpenOptionsExt;
                let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
                hasher.write_u32(std::process::id());
                let dir = base_dir.join(format!(
                    "EBWebView-{}-{:016x}",
                    std::process::id(),
                    hasher.finish()
                ));
                let _ = std::fs::create_dir_all(&dir);
                let lock = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .share_mode(0)
                    .open(dir.join(".instance.lock"))
                    .ok();
                (dir, lock)
            });
            use std::os::windows::ffi::OsStrExt;
            let mut wide: Vec<u16> = fallback_dir.as_os_str().encode_wide().collect();
            wide.push(0);
            f(
                browserexecutablefolder,
                PCWSTR(wide.as_ptr()),
                environmentoptions,
                environmentcreatedhandler,
            )
        } else {
            HRESULT(-2147467259)
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn GetAvailableCoreWebView2BrowserVersionString(
        browserexecutablefolder: PCWSTR,
        versioninfo: *mut PWSTR,
    ) -> HRESULT {
        type FnType = unsafe extern "system" fn(PCWSTR, *mut PWSTR) -> HRESULT;
        if let Some(p) = get_proc(b"GetAvailableCoreWebView2BrowserVersionString\0") {
            let f: FnType = core::mem::transmute(p);
            f(browserexecutablefolder, versioninfo)
        } else {
            HRESULT(-2147467259)
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn GetAvailableCoreWebView2BrowserVersionStringWithOptions(
        browserexecutablefolder: PCWSTR,
        environmentoptions: *mut c_void,
        versioninfo: *mut PWSTR,
    ) -> HRESULT {
        type FnType = unsafe extern "system" fn(PCWSTR, *mut c_void, *mut PWSTR) -> HRESULT;
        if let Some(p) = get_proc(b"GetAvailableCoreWebView2BrowserVersionStringWithOptions\0") {
            let f: FnType = core::mem::transmute(p);
            f(browserexecutablefolder, environmentoptions, versioninfo)
        } else {
            HRESULT(-2147467259)
        }
    }
}

#[cfg(test)]
mod loader_tests {
    #[test]
    fn embedded_loader_has_expected_exports_and_prunes_stale_dirs() {
        use super::embedded_loader;
        use std::os::windows::fs::OpenOptionsExt;

        let temp_root = std::env::temp_dir().join(format!(
            "yaoc-loader-prune-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&temp_root);
        let stale_dir = temp_root.join("1111-stale");
        let active_dir = temp_root.join("2222-active");
        std::fs::create_dir_all(&stale_dir).unwrap();
        std::fs::create_dir_all(&active_dir).unwrap();
        std::fs::write(stale_dir.join("WebView2Loader-x64.dll"), b"stale").unwrap();
        let active_dll = active_dir.join("WebView2Loader-x64.dll");
        std::fs::write(&active_dll, b"active").unwrap();
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&active_dll)
            .unwrap();

        embedded_loader::prune_stale_loader_dirs(&temp_root);
        assert!(!stale_dir.exists());
        assert!(active_dir.exists());

        drop(locked);
        let _ = std::fs::remove_dir_all(&temp_root);

        assert!(embedded_loader::test_export(b"GetAvailableCoreWebView2BrowserVersionString\0"));
        assert!(embedded_loader::test_export(b"CreateCoreWebView2EnvironmentWithOptions\0"));
    }
}
