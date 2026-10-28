//! Signed portable updates. Only `replace_executable` depends on the swap library.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, time::Duration};
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

const RELEASES: &str = "https://github.com/lzs/yaoc/releases";
const MANIFEST_URL: &str = "https://github.com/lzs/yaoc/releases/latest/download/latest.json";
const DOMAIN: &[u8] = b"YAOC-UPDATE-V1\n";
const MAX_BINARY: u64 = 200 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicIdentity {
    format_version: u32,
    algorithm: String,
    key_id: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    key_id: String,
    payload: String,
    signature: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    version: String,
    channel: String,
    assets: Vec<Asset>,
}

struct Pending {
    manifest: Manifest,
    staged: Option<tempfile::NamedTempFile>,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Option<Pending>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    release_url: String,
    size: u64,
}

fn verify_manifest(raw: &[u8], identity: &PublicIdentity) -> Result<Manifest, String> {
    if raw.len() > 64 * 1024 {
        return Err("Update manifest is too large".into());
    }
    let envelope: Envelope = serde_json::from_slice(raw).map_err(|_| "Invalid update envelope")?;
    if identity.format_version != 1
        || identity.algorithm != "ed25519"
        || envelope.key_id != identity.key_id
    {
        return Err("Unrecognized update signing identity".into());
    }
    let key: [u8; 32] = STANDARD
        .decode(&identity.public_key)
        .map_err(|_| "Invalid public key")?
        .try_into()
        .map_err(|_| "Invalid public key length")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "Invalid public key")?;
    let payload = STANDARD
        .decode(envelope.payload)
        .map_err(|_| "Invalid update payload")?;
    let signature = STANDARD
        .decode(envelope.signature)
        .map_err(|_| "Invalid signature encoding")?;
    let signature = Signature::from_slice(&signature).map_err(|_| "Invalid signature length")?;
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&payload);
    key.verify_strict(&message, &signature)
        .map_err(|_| "Update signature verification failed; nothing was installed")?;
    let manifest: Manifest =
        serde_json::from_slice(&payload).map_err(|_| "Invalid signed manifest")?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    let version =
        semver::Version::parse(&manifest.version).map_err(|_| "Invalid release version")?;
    if manifest.format_version != 1
        || manifest.channel != "official"
        || !version.pre.is_empty()
        || !version.build.is_empty()
        || version.to_string() != manifest.version
    {
        return Err("Only official, versioned releases are supported".into());
    }
    if manifest.assets.len() != 2 {
        return Err("Release must contain both Windows architectures".into());
    }
    for name in ["yaoc-x64.exe", "yaoc-arm64.exe"] {
        let matches: Vec<_> = manifest.assets.iter().filter(|a| a.name == name).collect();
        if matches.len() != 1 {
            return Err("Invalid release architectures".into());
        }
        let asset = matches[0];
        if asset.size == 0
            || asset.size > MAX_BINARY
            || asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid release artifact metadata".into());
        }
    }
    Ok(())
}

fn asset_for_host(manifest: &Manifest) -> Result<&Asset, String> {
    if !cfg!(target_os = "windows") {
        return Err("Portable updates currently support Windows only".into());
    }
    let name = match std::env::consts::ARCH {
        "x86_64" => "yaoc-x64.exe",
        "aarch64" => "yaoc-arm64.exe",
        _ => return Err("Unsupported update architecture".into()),
    };
    manifest
        .assets
        .iter()
        .find(|a| a.name == name)
        .ok_or("Release artifact missing".into())
}

fn release_url(manifest: &Manifest) -> String {
    format!("{RELEASES}/tag/v{}", manifest.version)
}

fn is_newer(version: &str, current: &str) -> Result<bool, String> {
    let version = semver::Version::parse(version).map_err(|_| "Invalid release version")?;
    let current = semver::Version::parse(current).map_err(|_| "Invalid installed version")?;
    Ok(version > current)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .user_agent(concat!("YAOC/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())
}

async fn response(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
    let result = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not download update: {e}"))?;
    if result.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(
            "No update manifest is published yet. You can check GitHub releases manually.".into(),
        );
    }
    result
        .error_for_status()
        .map_err(|e| format!("Update server returned an error: {e}"))
}

#[tauri::command]
pub async fn check_for_update(state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    *pending = None;
    let mut result = response(&client()?, MANIFEST_URL).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = result.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err("Update manifest is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let identity: PublicIdentity =
        serde_json::from_str(include_str!("../update-public.json")).map_err(|e| e.to_string())?;
    let manifest = verify_manifest(&bytes, &identity)?;
    if !is_newer(&manifest.version, env!("CARGO_PKG_VERSION"))? {
        return Ok(None);
    }
    let asset = asset_for_host(&manifest)?;
    let info = UpdateInfo {
        version: manifest.version.clone(),
        release_url: release_url(&manifest),
        size: asset.size,
    };
    *pending = Some(Pending {
        manifest,
        staged: None,
    });
    Ok(Some(info))
}

#[tauri::command]
pub async fn download_update(state: State<'_, UpdateState>) -> Result<(), String> {
    let mut pending = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    let pending = pending.as_mut().ok_or("Check for updates first")?;
    pending.staged = None;
    let asset = asset_for_host(&pending.manifest)?;
    let url = format!(
        "{RELEASES}/download/v{}/{}",
        pending.manifest.version, asset.name
    );
    let mut response = response(&client()?, &url).await?;
    if response
        .content_length()
        .is_some_and(|size| size != asset.size)
    {
        return Err("Update download size does not match the signed manifest".into());
    }
    let dir = crate::get_storage_dir()?.join("updates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = tempfile::Builder::new()
        .prefix("yaoc-update-")
        .suffix(".exe")
        .tempfile_in(dir)
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        size += chunk.len() as u64;
        if size > asset.size {
            return Err("Update exceeds the signed download size".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    if size != asset.size || hex::encode(hash.finalize()) != asset.sha256 {
        return Err("Update integrity verification failed; nothing was installed".into());
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    pending.staged = Some(file);
    Ok(())
}

fn verify_file(path: &Path, asset: &Asset) -> Result<(), String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != asset.size {
        return Err("Staged update size changed; download it again".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if hex::encode(hash.finalize()) != asset.sha256 {
        return Err("Staged update changed; download it again".into());
    }
    Ok(())
}

// Keep this adapter small so the dependency can be replaced or maintained independently.
fn replace_executable(path: &Path) -> Result<(), String> {
    self_replace::self_replace(path).map_err(|e| format!("Could not replace the executable: {e}"))
}

fn backup_path(executable: &Path) -> Result<std::path::PathBuf, String> {
    let name = executable.file_name().ok_or("Executable has no filename")?;
    let mut backup = std::ffi::OsString::from(".");
    backup.push(name);
    backup.push(".pre-update.exe");
    Ok(executable.with_file_name(backup))
}

fn prepare_replacement(
    staged: &Path,
    asset: &Asset,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    verify_file(staged, asset)?;
    // Windows changes current_exe() after moving the running image. Keep the
    // original path across failed attempts so a retry never updates the helper.
    static ORIGINAL: std::sync::OnceLock<Result<std::path::PathBuf, String>> =
        std::sync::OnceLock::new();
    let executable = ORIGINAL
        .get_or_init(|| {
            std::env::current_exe()
                .and_then(|p| p.canonicalize())
                .map_err(|e| e.to_string())
        })
        .clone()?;
    if std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| e.to_string())?
        != executable
    {
        return Err("A previous update attempt moved the running app. Fully quit and relaunch YAOC from its original path before retrying.".into());
    }
    let backup = backup_path(&executable)?;
    // Prepare the recovery copy before the library can rename the running image.
    fs::copy(&executable, &backup)
        .map_err(|e| format!("Could not create recovery backup: {e}. Try downloading manually."))?;
    fs::OpenOptions::new()
        .write(true)
        .open(&backup)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    replace_and_recover(staged, &executable, &backup, replace_executable)?;
    Ok((executable, backup))
}

fn replace_and_recover(
    staged: &Path,
    executable: &Path,
    backup: &Path,
    swap: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if let Err(error) = swap(staged) {
        // Windows replacement can fail after moving the old image aside.
        if !executable.exists() {
            fs::copy(backup, executable)
                .map_err(|e| format!("{error}. Restore {} manually: {e}", backup.display()))?;
        }
        return Err(error);
    }
    Ok(())
}

fn apply_replacement(staged: &Path, asset: &Asset) -> Result<(), String> {
    let (executable, backup) = prepare_replacement(staged, asset)?;
    let mut command = std::process::Command::new(&executable);
    command
        .arg("--yaoc-update-wait")
        .arg(std::process::id().to_string());
    if let Some(parent) = executable.parent() {
        command.current_dir(parent);
    }
    if let Err(error) = command.spawn() {
        // The running image has been relocated; restore the original path directly.
        fs::copy(&backup, &executable).map_err(|e| {
            format!(
                "Restart failed ({error}); restore {} manually: {e}",
                backup.display()
            )
        })?;
        return Err(format!(
            "Could not restart; previous executable restored: {error}"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let mut guard = state
        .0
        .try_lock()
        .map_err(|_| "An update operation is already running")?;
    let pending = guard.as_ref().ok_or("Check for updates first")?;
    let staged = pending.staged.as_ref().ok_or("Download the update first")?;
    let asset = asset_for_host(&pending.manifest)?;
    if !is_newer(&pending.manifest.version, env!("CARGO_PKG_VERSION"))? {
        return Err("Downgrades are not allowed".into());
    }
    apply_replacement(staged.path(), asset)?;
    // app.exit terminates without running all destructors; delete staging first.
    *guard = None;
    crate::window_state::save(&app);
    app.exit(0);
    Ok(())
}

/// The newly installed app waits for its predecessor before touching settings or hotkeys.
pub fn wait_for_predecessor() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != "--yaoc-update-wait") {
        return Ok(());
    }
    let pid: u32 = args
        .get(2)
        .and_then(|a| a.to_str())
        .and_then(|s| s.parse().ok())
        .filter(|pid| *pid != 0 && *pid != std::process::id())
        .ok_or("Invalid update restart process")?;
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
            fn GetLastError() -> u32;
        }
        let process = OpenProcess(0x00100000, 0, pid);
        if process.is_null() {
            // ERROR_INVALID_PARAMETER means the predecessor already exited.
            return if GetLastError() == 87 {
                Ok(())
            } else {
                Err(
                    "Could not wait for the previous app to close. Start YAOC again manually."
                        .into(),
                )
            };
        }
        let result = WaitForSingleObject(process, 60_000);
        CloseHandle(process);
        if result != 0 {
            return Err("The previous app has not closed. Start YAOC again after it exits.".into());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        return Err("Portable restart is only supported on Windows".into());
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn node_release_signer_and_rust_verifier_interoperate() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/update-manifest.json"))
                .unwrap();
        let identity: PublicIdentity = serde_json::from_value(fixture["identity"].clone()).unwrap();
        let manifest = verify_manifest(
            &serde_json::to_vec(&fixture["envelope"]).unwrap(),
            &identity,
        )
        .unwrap();
        assert_eq!(manifest.version, "2026.2.0");
        let embedded: PublicIdentity =
            serde_json::from_str(include_str!("../update-public.json")).unwrap();
        let public = STANDARD.decode(&embedded.public_key).unwrap();
        assert_eq!(embedded.key_id, &hex::encode(Sha256::digest(public))[..16]);
        // Test identities can never authenticate a production update.
        assert!(verify_manifest(
            &serde_json::to_vec(&fixture["envelope"]).unwrap(),
            &embedded
        )
        .is_err());
    }

    #[test]
    fn swap_failure_after_rename_restores_the_original_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("app.exe");
        let backup = dir.path().join("backup.exe");
        fs::write(&exe, b"original").unwrap();
        fs::copy(&exe, &backup).unwrap();
        let result = replace_and_recover(Path::new("unused"), &exe, &backup, |_| {
            fs::rename(&exe, dir.path().join("relocated.exe")).unwrap();
            Err("simulated failure after rename".into())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"original");
    }

    #[test]
    #[ignore = "only run in an isolated executable copy by native_replacement_preserves_backup"]
    fn replacement_child() {
        if std::env::var("YAOC_REPLACEMENT_PROBE").as_deref() != Ok("1") {
            return;
        }
        let exe = std::env::current_exe().unwrap();
        let staged = exe.with_file_name("staged.exe");
        let (manifest, _, _) = fixture();
        prepare_replacement(&staged, &manifest.assets[0]).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn native_replacement_preserves_backup() {
        let dir = tempfile::tempdir().unwrap();
        let source = std::env::current_exe().unwrap();
        let exe = dir.path().join("YAOC renamed Ω.exe");
        fs::copy(&source, &exe).unwrap();
        fs::write(dir.path().join("staged.exe"), b"exe").unwrap();
        let result = std::process::Command::new(&exe)
            .args([
                "--exact",
                "updater::tests::replacement_child",
                "--ignored",
                "--nocapture",
            ])
            .env("YAOC_REPLACEMENT_PROBE", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
        assert_eq!(fs::read(&exe).unwrap(), b"exe");
        let original = fs::read(&source).unwrap();
        assert_eq!(fs::read(backup_path(&exe).unwrap()).unwrap(), original);
    }

    fn fixture() -> (Manifest, PublicIdentity, SigningKey) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let identity = PublicIdentity {
            format_version: 1,
            algorithm: "ed25519".into(),
            key_id: "test".into(),
            public_key: STANDARD.encode(key.verifying_key().to_bytes()),
        };
        let manifest = Manifest {
            format_version: 1,
            version: "2026.2.0".into(),
            channel: "official".into(),
            assets: ["yaoc-x64.exe", "yaoc-arm64.exe"]
                .map(|name| Asset {
                    name: name.into(),
                    size: 3,
                    sha256: hex::encode(Sha256::digest(b"exe")),
                })
                .to_vec(),
        };
        (manifest, identity, key)
    }
    fn envelope(manifest: &Manifest, key: &SigningKey) -> Vec<u8> {
        let payload = serde_json::to_vec(manifest).unwrap();
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&payload);
        serde_json::to_vec(&serde_json::json!({"keyId":"test", "payload":STANDARD.encode(payload), "signature":STANDARD.encode(key.sign(&message).to_bytes())})).unwrap()
    }
    #[test]
    fn signed_metadata_rejects_tampering_wrong_keys_and_invalid_architectures() {
        let (mut manifest, mut identity, key) = fixture();
        let raw = envelope(&manifest, &key);
        assert!(verify_manifest(&raw, &identity).is_ok());
        identity.key_id = "other".into();
        assert!(verify_manifest(&raw, &identity).is_err());
        identity.key_id = "test".into();
        assert!(verify_manifest(
            &envelope(&manifest, &SigningKey::from_bytes(&[8; 32])),
            &identity
        )
        .is_err());
        let mut altered: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        manifest.version = "2026.9.0".into();
        altered["payload"] = STANDARD
            .encode(serde_json::to_vec(&manifest).unwrap())
            .into();
        assert!(verify_manifest(&serde_json::to_vec(&altered).unwrap(), &identity).is_err());
        manifest.assets[0].name = "../evil.exe".into();
        assert!(verify_manifest(&envelope(&manifest, &key), &identity).is_err());
    }
    #[test]
    fn official_versions_sizes_and_hashes_are_required() {
        let (mut manifest, _, _) = fixture();
        for version in ["2026.2.0-beta", "2026.2.0+tag", "../evil", "v2026.2.0"] {
            manifest.version = version.into();
            assert!(validate_manifest(&manifest).is_err());
        }
        manifest.version = "2026.2.0".into();
        manifest.assets[0].size = MAX_BINARY + 1;
        assert!(validate_manifest(&manifest).is_err());
        manifest.assets[0].size = 3;
        manifest.assets[0].sha256 = "z".repeat(64);
        assert!(validate_manifest(&manifest).is_err());
        assert!(is_newer("2026.1.0", "2026.1.0-dev10282114").unwrap());
        assert!(!is_newer("2026.1.0", "2026.2.0").unwrap());
        assert!(!is_newer("2026.1.0", "2026.1.0").unwrap());
    }
    #[test]
    fn staged_files_are_rechecked_and_renamed_apps_keep_their_backup_name() {
        let (manifest, _, _) = fixture();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"exe").unwrap();
        assert!(verify_file(file.path(), &manifest.assets[0]).is_ok());
        fs::write(file.path(), b"bad").unwrap();
        assert!(verify_file(file.path(), &manifest.assets[0]).is_err());
        fs::write(file.path(), b"shorter").unwrap();
        assert!(verify_file(file.path(), &manifest.assets[0]).is_err());
        assert_eq!(
            backup_path(Path::new("custom name.exe")).unwrap(),
            Path::new(".custom name.exe.pre-update.exe")
        );
    }
}
