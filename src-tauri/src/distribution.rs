//! Per-executable distribution mode; user data is shared by both modes.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Installed,
    Portable,
    Msix,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub mode: Mode,
    pub executable: PathBuf,
    pub data_directory: PathBuf,
    pub webview_directory: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    format_version: u32,
    install_directory: PathBuf,
}
static DISTRIBUTION: OnceLock<Distribution> = OnceLock::new();

fn detect(executable: &Path) -> Result<Mode, String> {
    let directory = executable
        .parent()
        .ok_or("Executable directory is missing")?;
    let path = directory.join("install-metadata.json");
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Mode::Portable),
        Err(e) => return Err(format!("Cannot read installation metadata: {e}")),
    };
    let text = if raw.starts_with(&[0xff, 0xfe]) {
        if raw.len() % 2 != 0 {
            return Err("Invalid installation metadata encoding".into());
        }
        let units: Vec<u16> = raw[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        String::from_utf16(&units).map_err(|e| e.to_string())?
    } else {
        String::from_utf8(raw).map_err(|e| e.to_string())?
    };
    let metadata: Metadata = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid installation metadata. Reinstall YAOC: {e}"))?;
    if metadata.format_version != 1
        || !metadata.install_directory.is_absolute()
        || metadata
            .install_directory
            .canonicalize()
            .map_err(|e| e.to_string())?
            != directory.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("Installation metadata does not match this location. Reinstall YAOC, or use a standalone executable in a folder without installation metadata.".into());
    }
    Ok(Mode::Installed)
}
// A package identity takes precedence over sidecar metadata. Never treat MSIX as NSIS.
#[cfg(windows)]
pub fn packaged_app_id() -> Result<Option<String>, String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentApplicationUserModelId(length: *mut u32, id: *mut u16) -> i32;
    }
    let mut length = 0;
    let result = unsafe { GetCurrentApplicationUserModelId(&mut length, std::ptr::null_mut()) };
    if result == 15703 {
        // APPMODEL_ERROR_NO_APPLICATION
        return Ok(None);
    }
    if result != 122 {
        // ERROR_INSUFFICIENT_BUFFER
        return Err(format!("Cannot query Windows package identity: {result}"));
    }
    let mut buffer = vec![0u16; length as usize];
    let result = unsafe { GetCurrentApplicationUserModelId(&mut length, buffer.as_mut_ptr()) };
    if result != 0 {
        return Err(format!("Cannot read Windows package identity: {result}"));
    }
    let id = String::from_utf16(&buffer[..length.saturating_sub(1) as usize])
        .map_err(|e| e.to_string())?;
    Ok(Some(id))
}
#[cfg(not(windows))]
pub fn packaged_app_id() -> Result<Option<String>, String> {
    Ok(None)
}
pub fn initialize() -> Result<(), String> {
    let executable = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| e.to_string())?;
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("LOCALAPPDATA must be an absolute directory")?;
    let distribution = Distribution {
        mode: if packaged_app_id()?.is_some() {
            Mode::Msix
        } else {
            detect(&executable)?
        },
        executable,
        data_directory: crate::storage::user_storage_dir()?,
        webview_directory: local.join("io.github.lzs.yaoc"),
    };
    DISTRIBUTION
        .set(distribution)
        .map_err(|_| "Distribution already initialized".into())
}
pub fn current() -> &'static Distribution {
    DISTRIBUTION
        .get()
        .expect("distribution initialized before app setup")
}
pub fn require_installed() -> Result<(), String> {
    require_mode(current().mode)
}
fn require_mode(mode: Mode) -> Result<(), String> {
    if mode == Mode::Installed {
        Ok(())
    } else {
        Err(if mode == Mode::Msix {
            "MSIX updates are managed by Microsoft Store or your MSIX distribution source."
        } else {
            "Portable copies must be updated manually from the official download page."
        }
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_cannot_install() {
        assert!(require_mode(Mode::Portable).is_err());
        assert!(require_mode(Mode::Msix).unwrap_err().contains("MSIX"));
        assert!(require_mode(Mode::Installed).is_ok());
    }
    #[test]
    fn metadata_is_local_and_validated() {
        let folder = tempfile::tempdir().unwrap();
        let exe = folder.path().join("yaoc.exe");
        assert_eq!(detect(&exe).unwrap(), Mode::Portable);
        let marker = folder.path().join("install-metadata.json");
        fs::write(&marker, "broken").unwrap();
        assert!(detect(&exe).is_err());
        fs::write(
            &marker,
            serde_json::json!({"formatVersion":1,"installDirectory":folder.path()}).to_string(),
        )
        .unwrap();
        assert_eq!(detect(&exe).unwrap(), Mode::Installed);
        let text =
            serde_json::json!({"formatVersion":1,"installDirectory":folder.path()}).to_string();
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&marker, utf16).unwrap();
        assert_eq!(detect(&exe).unwrap(), Mode::Installed);
        let other = tempfile::tempdir().unwrap();
        fs::write(
            &marker,
            serde_json::json!({"formatVersion":1,"installDirectory":other.path()}).to_string(),
        )
        .unwrap();
        assert!(detect(&exe).is_err());
        assert_eq!(
            detect(&other.path().join("yaoc.exe")).unwrap(),
            Mode::Portable
        );
    }
}
