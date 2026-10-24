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

    static MODULE_HANDLE: OnceLock<usize> = OnceLock::new();

    fn get_proc(name: &[u8]) -> Option<*mut c_void> {
        let hmod = *MODULE_HANDLE.get_or_init(|| {
            use std::hash::{BuildHasher, Hasher};
            use std::io::Write;
            use std::os::windows::ffi::OsStrExt;
            use std::os::windows::fs::OpenOptionsExt;
            // A private per-process directory prevents reuse of an attacker-planted cache.
            let root = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir).join("yaoc").join("WebView2Loader");
            if std::fs::create_dir_all(&root).is_err() { return 0; }
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_u32(std::process::id());
            let dir = root.join(format!("{}-{:016x}", std::process::id(), hasher.finish()));
            if std::fs::create_dir(&dir).is_err() { return 0; }
            let dll_path = dir.join(format!("WebView2Loader-{ARCH_NAME}.dll"));
            let written = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&dll_path)?;
                file.write_all(LOADER_BYTES)?;
                file.sync_all()
            })();
            if written.is_err() { return 0; }
            // Deny concurrent writes/deletion while validating and loading the exact bytes.
            let Ok(mut locked) = std::fs::OpenOptions::new().read(true).share_mode(1).open(&dll_path) else { return 0; };
            if locked.metadata().map(|info| info.len() != LOADER_BYTES.len() as u64).unwrap_or(true) { return 0; }
            let mut bytes = Vec::with_capacity(LOADER_BYTES.len());
            if std::io::Read::read_to_end(&mut locked, &mut bytes).is_err() || bytes != LOADER_BYTES { return 0; }
            let wide: Vec<u16> = dll_path.as_os_str().encode_wide().chain(Some(0)).collect();
            // Search this DLL's directory and System32, never the current working directory.
            unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), 0x00000100 | 0x00000800) as usize }

        });
        if hmod == 0 {
            return None;
        }
        let ptr = unsafe { GetProcAddress(hmod as *mut c_void, name.as_ptr()) };
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
            let base_dir = std::env::var("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("ai.openclaw.chat.lite");
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

            // Fallback to a per-process userdatafolder so multiple/concurrent instances never fail with 0x800700AA
            let fallback_dir = base_dir.join(format!("EBWebView-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&fallback_dir);
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
    fn embedded_loader_has_expected_exports() {
        use super::embedded_loader;
        assert!(embedded_loader::test_export(b"GetAvailableCoreWebView2BrowserVersionString\0"));
        assert!(embedded_loader::test_export(b"CreateCoreWebView2EnvironmentWithOptions\0"));
    }
}
