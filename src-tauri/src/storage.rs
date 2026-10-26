//! Atomic writes and Windows DPAPI secret protection for user-owned profile and identity files.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub const DPAPI_PREFIX: &str = "dpapi:";
const DPAPI_ENTROPY: &[u8] = b"yaoc.openclaw.credentials.v1";

pub fn user_storage_dir() -> PathBuf {
    if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
        return PathBuf::from(appdata).join("openclaw-chat");
    }
    #[cfg(target_os = "windows")]
    if let Some(roaming) = dpapi::known_roaming_appdata_dir() {
        return roaming.join("openclaw-chat");
    }
    if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
        return PathBuf::from(local_appdata).join("openclaw-chat");
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
        return PathBuf::from(user_profile)
            .join("AppData")
            .join("Roaming")
            .join("openclaw-chat");
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(xdg).join("openclaw-chat");
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home).join(".config").join("openclaw-chat");
    }
    std::env::temp_dir().join("openclaw-chat")
}

pub fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing file name"))?;
    let temporary = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "windows")]
mod dpapi {
    use super::*;
    use std::ffi::c_void;
    use std::ptr;

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[repr(C)]
    struct CryptoApiBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const CryptoApiBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const CryptoApiBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut CryptoApiBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const CryptoApiBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const CryptoApiBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut CryptoApiBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    // FOLDERID_RoamingAppData = {3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}
    const FOLDERID_ROAMING_APPDATA: Guid = Guid {
        data1: 0x3EB685DB,
        data2: 0x65F9,
        data3: 0x4CF6,
        data4: [0xA0, 0x3A, 0xE3, 0xEF, 0x65, 0x72, 0x9F, 0x3D],
    };

    #[link(name = "shell32")]
    extern "system" {
        fn SHGetKnownFolderPath(
            rfid: *const Guid,
            dw_flags: u32,
            h_token: *mut c_void,
            ppsz_path: *mut *mut u16,
        ) -> i32;
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoTaskMemFree(pv: *mut c_void);
    }

    pub fn known_roaming_appdata_dir() -> Option<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        let mut raw_path: *mut u16 = ptr::null_mut();
        let hr = unsafe {
            SHGetKnownFolderPath(
                &FOLDERID_ROAMING_APPDATA,
                0,
                ptr::null_mut(),
                &mut raw_path,
            )
        };
        if hr < 0 || raw_path.is_null() {
            return None;
        }
        let path = unsafe {
            let mut len = 0usize;
            while *raw_path.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(raw_path, len);
            let os_str = std::ffi::OsString::from_wide(slice);
            CoTaskMemFree(raw_path as *mut c_void);
            PathBuf::from(os_str)
        };
        if path.as_os_str().is_empty() {
            None
        } else {
            Some(path)
        }
    }

    pub fn protect(plaintext: &str) -> Result<String, String> {
        if plaintext.is_empty() {
            return Ok(String::new());
        }
        if plaintext.starts_with(DPAPI_PREFIX) {
            let _ = unprotect(plaintext)?;
            return Ok(plaintext.to_string());
        }
        let in_bytes = plaintext.as_bytes();
        let in_blob = CryptoApiBlob {
            cb_data: u32::try_from(in_bytes.len()).map_err(|_| "Secret is too large")?,
            pb_data: in_bytes.as_ptr() as *mut u8,
        };
        let entropy_blob = CryptoApiBlob {
            cb_data: DPAPI_ENTROPY.len() as u32,
            pb_data: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob = CryptoApiBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                ptr::null(),
                &entropy_blob,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pb_data.is_null() {
            return Err("Could not encrypt secret with Windows DPAPI".to_string());
        }
        let encrypted = unsafe {
            let slice = std::slice::from_raw_parts_mut(out_blob.pb_data, out_blob.cb_data as usize);
            let vec = slice.to_vec();
            slice.fill(0);
            LocalFree(out_blob.pb_data as *mut c_void);
            vec
        };
        Ok(format!("{DPAPI_PREFIX}{}", URL_SAFE_NO_PAD.encode(encrypted)))
    }

    pub fn unprotect(stored: &str) -> Result<(String, bool), String> {
        if stored.is_empty() {
            return Ok((String::new(), true));
        }
        let Some(encoded) = stored.strip_prefix(DPAPI_PREFIX) else {
            return Ok((stored.to_string(), false));
        };
        let mut cipher_bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|e| format!("Saved DPAPI secret has invalid encoding: {e}"))?;
        if cipher_bytes.is_empty() {
            return Err("Saved DPAPI secret is empty".to_string());
        }
        let in_blob = CryptoApiBlob {
            cb_data: u32::try_from(cipher_bytes.len()).map_err(|_| "Encrypted secret is too large")?,
            pb_data: cipher_bytes.as_mut_ptr(),
        };
        let entropy_blob = CryptoApiBlob {
            cb_data: DPAPI_ENTROPY.len() as u32,
            pb_data: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut out_blob = CryptoApiBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                ptr::null_mut(),
                &entropy_blob,
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pb_data.is_null() {
            return Err(
                "Could not decrypt saved secret with Windows DPAPI (it may belong to another Windows user or be corrupted)"
                    .to_string(),
            );
        }
        let decrypted = unsafe {
            let slice = std::slice::from_raw_parts_mut(out_blob.pb_data, out_blob.cb_data as usize);
            let vec = slice.to_vec();
            slice.fill(0);
            LocalFree(out_blob.pb_data as *mut c_void);
            vec
        };
        let plaintext = String::from_utf8(decrypted)
            .map_err(|_| "Decrypted DPAPI secret is not valid UTF-8".to_string())?;
        Ok((plaintext, true))
    }
}

#[cfg(target_os = "windows")]
pub use dpapi::{protect as protect_secret, unprotect as unprotect_secret};

#[cfg(not(target_os = "windows"))]
pub fn protect_secret(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    if plaintext.starts_with(DPAPI_PREFIX) {
        return Ok(plaintext.to_string());
    }
    eprintln!(
        "WARNING: Encrypted credential storage (Windows DPAPI) is not supported on this platform. Secrets will be stored in cleartext."
    );
    Ok(format!("{DPAPI_PREFIX}{}", URL_SAFE_NO_PAD.encode(plaintext.as_bytes())))
}

#[cfg(not(target_os = "windows"))]
pub fn unprotect_secret(stored: &str) -> Result<(String, bool), String> {
    if stored.is_empty() {
        return Ok((String::new(), true));
    }
    let Some(encoded) = stored.strip_prefix(DPAPI_PREFIX) else {
        return Ok((stored.to_string(), false));
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|e| format!("Invalid secret encoding: {e}"))?;
    let s = String::from_utf8(bytes).map_err(|_| "Invalid UTF-8 in secret".to_string())?;
    Ok((s, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_existing_file_and_leaves_no_temporary_files() {
        let dir = std::env::temp_dir().join(format!(
            "yaoc-storage-test-{}-{}",
            std::process::id(),
            WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("profiles.json");
        atomic_write(&path, "old").unwrap();
        atomic_write(&path, "new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn reports_write_failures() {
        let path = std::env::temp_dir()
            .join(format!("yaoc-missing-{}", std::process::id()))
            .join("missing")
            .join("profiles.json");
        assert!(atomic_write(&path, "data").is_err());
    }
    #[test]
    fn dpapi_roundtrips_and_migrates_legacy_plaintext() {
        let secret = "super-secret-gateway-token-12345";
        let protected = protect_secret(secret).unwrap();
        assert!(protected.starts_with(DPAPI_PREFIX));
        assert!(!protected.contains(secret));

        let (decrypted, was_protected) = unprotect_secret(&protected).unwrap();
        assert!(was_protected);
        assert_eq!(decrypted, secret);

        // Idempotent when already protected
        assert_eq!(protect_secret(&protected).unwrap(), protected);

        // Legacy plaintext is recognized for transparent migration
        let (legacy, was_legacy_protected) = unprotect_secret("legacy-plaintext-token").unwrap();
        assert!(!was_legacy_protected);
        assert_eq!(legacy, "legacy-plaintext-token");

        // Corrupted DPAPI payload fails cleanly
        assert!(unprotect_secret("dpapi:not_a_valid_dpapi_blob").is_err());
    }
}
