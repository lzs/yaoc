//! Official release discovery and installer-only updates. No portable replacement path.
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const ENDPOINT: &str = "https://github.com/lzs/yaoc/releases/latest/download/installer-update.json";
const RELEASES: &str = "https://github.com/lzs/yaoc/releases";
const PUBLIC_KEY: &str = match option_env!("YAOC_UPDATER_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};
struct Pending {
    update: Update,
    bytes: Option<Vec<u8>>,
}
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Pending>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    release_url: String,
    can_install: bool,
}
#[derive(Deserialize)]
struct Release {
    version: String,
}
fn official_newer(version: &str) -> Result<bool, String> {
    let version = semver::Version::parse(version).map_err(|_| "Invalid update version")?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("Only official releases are supported".into());
    }
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    Ok(version > current)
}
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    *pending = None;
    let client = reqwest::Client::builder()
        .https_only(true)
        .user_agent(concat!("YAOC/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(ENDPOINT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("No official update metadata is published yet. Open the download page to check releases.".into());
    }
    response = response.error_for_status().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 65536 {
            return Err("Update metadata is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let release: Release =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid release metadata: {e}"))?;
    if !official_newer(&release.version)? {
        return Ok(None);
    }
    let installed = crate::distribution::current().mode == crate::distribution::Mode::Installed;
    if installed {
        if PUBLIC_KEY.is_empty() {
            return Err("Installer updates are not configured in this build (missing updater public key). Download an installer manually.".into());
        }
        let before_exit = app.clone();
        let update = app
            .updater_builder()
            .pubkey(PUBLIC_KEY)
            .endpoints(vec![ENDPOINT
                .parse()
                .map_err(|e: url::ParseError| e.to_string())?])
            .map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(180))
            .on_before_exit(move || crate::window_state::save(&before_exit))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Release changed while checking; check again")?;
        if update.version != release.version || !official_newer(&update.version)? {
            return Err("Release changed while checking; check again".into());
        }
        let expected = format!("{RELEASES}/download/v{}/", release.version);
        if !update.download_url.as_str().starts_with(&expected) {
            return Err("Installer URL is outside the official versioned release".into());
        }
        *pending = Some(Pending {
            update,
            bytes: None,
        });
    }
    Ok(Some(UpdateInfo {
        release_url: format!("{RELEASES}/tag/v{}", release.version),
        version: release.version,
        can_install: installed,
    }))
}
#[tauri::command]
pub async fn download_update(state: State<'_, UpdateState>) -> Result<(), String> {
    crate::distribution::require_installed()?;
    let mut guard = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    let pending = guard.as_mut().ok_or("Check for updates first")?;
    pending.bytes = None;
    let (limit_tx, mut limit_rx) = tokio::sync::mpsc::channel::<()>(1);
    let mut received = 0usize;
    let download = pending.update.download(
        move |chunk, total| {
            received = received.saturating_add(chunk);
            if received > 200 * 1024 * 1024 || total.is_some_and(|n| n > 200 * 1024 * 1024) {
                let _ = limit_tx.try_send(());
            }
        },
        || {},
    );
    let bytes = tokio::select! {
        biased;
        Some(()) = limit_rx.recv() => return Err("Installer exceeds the 200 MB download limit".into()),
        result = download => result.map_err(|e| format!("Installer download/verification failed: {e}"))?,
    };
    pending.bytes = Some(bytes);
    Ok(())
}
#[tauri::command]
pub async fn install_update(state: State<'_, UpdateState>) -> Result<(), String> {
    crate::distribution::require_installed()?;
    let mut guard = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    let pending = guard.as_mut().ok_or("Check for updates first")?;
    let bytes = pending.bytes.as_ref().ok_or("Download the update first")?;
    // Tauri re-verifies the signature, launches NSIS with the installation path, and exits Windows.
    pending
        .update
        .install(bytes)
        .map_err(|e| format!("Installer update failed: {e}"))
}
#[cfg(test)]
mod tests {
    #[test]
    fn only_official_versions() {
        assert!(super::official_newer("2027.1.0").unwrap());
        assert!(!super::official_newer("2020.1.0").unwrap());
        assert!(super::official_newer("2027.1.0-dev1").is_err());
        assert!(super::official_newer("2027.1.0+test").is_err());
    }
}
