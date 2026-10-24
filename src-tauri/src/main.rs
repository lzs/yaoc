#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod efficiency;
mod storage;

use storage::atomic_write;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{
    pkcs8::{spki::der::pem::LineEnding, DecodePrivateKey, EncodePrivateKey, EncodePublicKey},
    Signer, SigningKey,
};
use futures_util::{SinkExt, StreamExt};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, protocol::Message},
    Connector,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayProfile {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub device_token: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_mode: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub allow_insecure_tls: Option<bool>,
    #[serde(default)]
    pub include_device_identity: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub public_key_base64_url: String,
    pub private_key_pem: String,
    #[serde(default)]
    pub public_key_pem: String,
}

fn get_storage_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("openclaw-chat")
    } else {
        std::env::temp_dir().join("openclaw-chat")
    }
}

fn load_or_create_device_identity() -> Result<DeviceIdentity, String> {
    let dir = get_storage_dir();
    let file_path = dir.join("device-identity.json");
    match fs::read_to_string(&file_path) {
        Ok(raw) => {
            let identity: DeviceIdentity = serde_json::from_str(&raw)
                .map_err(|e| format!("Saved device identity is invalid; restore device-identity.json from a backup: {e}"))?;
            let key = SigningKey::from_pkcs8_pem(&identity.private_key_pem)
                .map_err(|_| "Saved device identity contains an invalid private key".to_string())?;
            let public_key = key.verifying_key().to_bytes();
            if identity.public_key_base64_url != URL_SAFE_NO_PAD.encode(public_key)
                || identity.device_id != hex::encode(Sha256::digest(public_key))
            {
                return Err("Saved device identity does not match its private key".to_string());
            }
            return Ok(identity);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not read device-identity.json: {error}")),
    }

    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key = signing_key.verifying_key();
    let raw_pub = verifying_key.to_bytes();

    let mut hasher = Sha256::new();
    hasher.update(raw_pub);
    let device_id = hex::encode(hasher.finalize());
    let public_key_base64_url = URL_SAFE_NO_PAD.encode(raw_pub);
    let private_key_pem = signing_key
        .to_pkcs8_pem(LineEnding::LF)
        .map(|s| s.to_string())
        .map_err(|e| format!("Could not encode device private key: {e}"))?;
    let public_key_pem = verifying_key
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| format!("Could not encode device public key: {e}"))?;

    let identity = DeviceIdentity {
        device_id,
        public_key_base64_url,
        private_key_pem,
        public_key_pem,
    };

    fs::create_dir_all(&dir).map_err(|e| format!("Could not create settings directory: {e}"))?;
    let serialized = serde_json::to_string_pretty(&identity).map_err(|e| e.to_string())?;
    atomic_write(&file_path, &serialized)
        .map_err(|e| format!("Could not save device identity: {e}"))?;
    Ok(identity)
}

struct DeviceChallenge<'a> {
    client_id: &'a str,
    client_mode: &'a str,
    role: &'a str,
    scopes: &'a [&'a str],
    signed_at_ms: u128,
    token: &'a str,
    nonce: &'a str,
    platform: &'a str,
    device_family: &'a str,
}

fn sign_device_challenge_v3(
    identity: &DeviceIdentity,
    challenge: DeviceChallenge<'_>,
) -> Result<String, String> {
    let DeviceChallenge {
        client_id,
        client_mode,
        role,
        scopes,
        signed_at_ms,
        token,
        nonce,
        platform,
        device_family,
    } = challenge;
    let payload = format!(
        "v3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        identity.device_id,
        client_id,
        client_mode,
        role,
        scopes.join(","),
        signed_at_ms,
        token,
        nonce,
        platform,
        device_family
    );
    let signing_key = SigningKey::from_pkcs8_pem(&identity.private_key_pem)
        .map_err(|e| format!("Failed to parse Ed25519 private key: {}", e))?;
    let sig = signing_key.sign(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

fn normalize_gateway_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "ws://127.0.0.1:18789".to_string();
    }
    if trimmed.starts_with("mock://")
        || trimmed.starts_with("ws://")
        || trimmed.starts_with("wss://")
    {
        return trimmed.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return format!("ws://{}", rest);
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return format!("wss://{}", rest);
    }
    if trimmed.starts_with("127.0.0.1") || trimmed.starts_with("localhost") {
        return format!("ws://{}", trimmed);
    }
    format!("wss://{}", trimmed)
}

fn gateway_origin(endpoint: &url::Url) -> Result<String, String> {
    let scheme = match endpoint.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => return Err("Gateway endpoint must use ws:// or wss://".to_string()),
    };
    let mut origin = endpoint.clone();
    origin
        .set_scheme(scheme)
        .map_err(|_| "Invalid Gateway origin".to_string())?;
    Ok(origin.origin().ascii_serialization())
}

fn authentication_token(profile: &GatewayProfile) -> &str {
    profile
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .or_else(|| {
            profile
                .device_token
                .as_deref()
                .map(str::trim)
                .filter(|token| !token.is_empty())
        })
        .unwrap_or("")
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, Value>>>>>;

pub struct GatewayState {
    identity: DeviceIdentity,
    ws_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: PendingMap,
    connection_epoch: AtomicU64,
    connection_tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    connect_lock: Mutex<()>,
    req_counter: AtomicU64,
    is_mock: Mutex<bool>,
    mock_files: Mutex<HashMap<String, String>>,
    mock_session_models: Mutex<HashMap<String, String>>,
    mock_session_thinking: Mutex<HashMap<String, String>>,
    mock_session_labels: Mutex<HashMap<String, String>>,
}

impl GatewayState {
    pub fn new() -> Result<Self, String> {
        Ok(Self::with_identity(load_or_create_device_identity()?))
    }

    fn with_identity(identity: DeviceIdentity) -> Self {
        let mut mock_files = HashMap::new();
        mock_files.insert(
            "AGENTS.md".to_string(),
            "# AGENTS.md - Operating Instructions\n\n- Prioritize clear, concise explanations.\n- Running inside lightweight Tauri v2 (Rust + WebView2) shell.".to_string(),
        );
        mock_files.insert(
            "SOUL.md".to_string(),
            "# SOUL.md - Persona\n\nYou are OpenClaw, a fast, pragmatic engineering assistant."
                .to_string(),
        );
        mock_files.insert(
            "USER.md".to_string(),
            "# USER.md\n\n- OS: Windows (x64 & ARM64)\n- Runtime: Tauri v2 (No bundled Chromium)"
                .to_string(),
        );
        mock_files.insert(
            "MEMORY.md".to_string(),
            "# MEMORY.md\n\n- Built with Tauri v2 (Rust + OS WebView2).".to_string(),
        );

        Self {
            identity,
            connection_epoch: AtomicU64::new(0),
            connection_tasks: Mutex::new(Vec::new()),
            connect_lock: Mutex::new(()),
            ws_tx: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            req_counter: AtomicU64::new(1),
            is_mock: Mutex::new(false),
            mock_files: Mutex::new(mock_files),
            mock_session_models: Mutex::new(HashMap::new()),
            mock_session_thinking: Mutex::new(HashMap::new()),
            mock_session_labels: Mutex::new(HashMap::new()),
        }
    }

    fn is_current_connection(&self, epoch: u64) -> bool {
        self.connection_epoch.load(Ordering::SeqCst) == epoch
    }

    pub async fn disconnect(&self) {
        self.disconnect_connection(None, None).await;
    }

    async fn disconnect_connection(
        &self,
        expected_epoch: Option<u64>,
        status: Option<(&AppHandle, &str, &str)>,
    ) -> bool {
        let mut tasks = self.connection_tasks.lock().await;
        if expected_epoch.is_some_and(|epoch| !self.is_current_connection(epoch)) {
            return false;
        }
        self.connection_epoch.fetch_add(1, Ordering::SeqCst);
        *self.is_mock.lock().await = false;
        self.ws_tx.lock().await.take();
        for (_, sender) in self.pending.lock().await.drain() {
            let _ = sender.send(Err(json!({ "message": "Disconnected" })));
        }
        if let Some((app, endpoint, message)) = status {
            let _ = app.emit(
                "gateway:status",
                json!({ "state": "disconnected", "endpoint": endpoint, "message": message }),
            );
        }
        for task in tasks.drain(..) {
            task.abort();
        }
        true
    }

    pub async fn send_rpc(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, Value> {
        let tx_opt = self.ws_tx.lock().await.clone();
        let tx = tx_opt.ok_or_else(|| json!({ "message": "WebSocket is not connected" }))?;

        let id = format!(
            "req-{}-{}",
            self.req_counter.fetch_add(1, Ordering::SeqCst),
            now_ms()
        );
        let frame = json!({
            "type": "req",
            "id": id,
            "method": method,
            "params": params
        });

        let (resp_tx, resp_rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), resp_tx);

        if tx.send(frame.to_string()).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(json!({ "message": "Failed to send over WebSocket" }));
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), resp_rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(json!({ "message": format!("RPC {} channel closed", method) })),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(
                    json!({ "message": format!("RPC timeout ({}ms) calling {}", timeout_ms, method) }),
                )
            }
        }
    }
}

#[tauri::command]
fn get_system_info(state: State<'_, Arc<GatewayState>>) -> Value {
    log_boot("IPC get_system_info called");
    json!({
        "platform": "win32",
        "arch": std::env::consts::ARCH,
        "runtime": "tauri-v2",
        "deviceIdentity": {
            "deviceId": state.identity.device_id,
            "publicKey": state.identity.public_key_base64_url
        }
    })
}

#[tauri::command]
fn load_profiles() -> Result<Value, String> {
    log_boot("IPC load_profiles called");
    let path = get_storage_dir().join("gateway-profiles.json");
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let value: Value = serde_json::from_str(&raw).map_err(|e| {
                format!(
                    "Saved profiles are invalid; restore gateway-profiles.json from a backup: {e}"
                )
            })?;
            let profiles = value
                .get("profiles")
                .ok_or("Saved profiles are missing the profiles array")?;
            serde_json::from_value::<Vec<GatewayProfile>>(profiles.clone())
                .map_err(|e| format!("Saved profiles are invalid: {e}"))?;
            return Ok(value);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not read saved profiles: {error}")),
    }

    Ok(json!({
        "profiles": [
            {
                "id": "local-default",
                "name": "Local Gateway (127.0.0.1:18789)",
                "endpoint": "ws://127.0.0.1:18789",
                "token": "",
                "clientId": "gateway-client",
                "clientMode": "ui",
                "role": "operator",
                "allowInsecureTls": false,
                "includeDeviceIdentity": true
            },
            {
                "id": "demo-mock",
                "name": "Built-in Demo Gateway (Offline Test)",
                "endpoint": "mock://demo",
                "token": "",
                "clientId": "gateway-client",
                "clientMode": "ui",
                "role": "operator",
                "allowInsecureTls": false,
                "includeDeviceIdentity": true
            }
        ],
        "activeProfileId": "local-default"
    }))
}

#[tauri::command]
fn save_profiles(
    profiles: Value,
    active_profile_id: String,
    ui_state: Option<Value>,
) -> Result<Value, String> {
    serde_json::from_value::<Vec<GatewayProfile>>(profiles.clone())
        .map_err(|e| format!("Invalid connection profiles: {e}"))?;
    let dir = get_storage_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create settings directory: {e}"))?;
    let path = dir.join("gateway-profiles.json");
    let existing_ui_state = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("uiState").cloned());
    let final_ui_state = ui_state
        .filter(|v| !v.is_null())
        .or(existing_ui_state)
        .unwrap_or_else(|| json!({}));
    let data = json!({
        "profiles": profiles,
        "activeProfileId": active_profile_id,
        "uiState": final_ui_state
    });
    let pretty = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    atomic_write(&path, &pretty).map_err(|e| format!("Could not save connection profiles: {e}"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn gateway_disconnect(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
) -> Result<Value, String> {
    state.disconnect().await;
    let _ = app.emit(
        "gateway:status",
        json!({ "state": "disconnected", "message": "Disconnected" }),
    );
    Ok(json!({ "ok": true }))
}

#[tauri::command]
async fn gateway_connect(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
    profile: GatewayProfile,
) -> Result<Value, String> {
    let _connect_guard = state.connect_lock.lock().await;
    state.disconnect().await;
    let epoch = state.connection_epoch.load(Ordering::SeqCst);
    let ws_url = normalize_gateway_url(&profile.endpoint);

    if ws_url.starts_with("mock://") {
        *state.is_mock.lock().await = true;
        let hello = json!({
            "protocol": 4,
            "server": { "version": "2026.10.22-tauri-demo", "host": "mock://demo" },
            "auth": { "role": "operator", "scopes": ["operator.read", "operator.write", "operator.approvals"] }
        });
        let _ = app.emit(
            "gateway:status",
            json!({
                "state": "connected",
                "endpoint": ws_url,
                "hello": hello
            }),
        );
        return Ok(json!({ "ok": true, "hello": hello }));
    }

    let _ = app.emit(
        "gateway:status",
        json!({
            "state": "connecting",
            "endpoint": ws_url,
            "message": format!("Connecting to {}...", ws_url)
        }),
    );

    let parsed_url = match url::Url::parse(&ws_url) {
        Ok(u) => u,
        Err(e) => {
            let msg = format!("Invalid URL {}: {}", ws_url, e);
            let _ = app.emit(
                "gateway:status",
                json!({ "state": "error", "endpoint": ws_url, "message": msg }),
            );
            return Ok(json!({ "ok": false, "error": { "message": msg } }));
        }
    };

    let origin = gateway_origin(&parsed_url)?;

    let mut request = match ws_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Failed to build request: {}", e);
            let _ = app.emit(
                "gateway:status",
                json!({ "state": "error", "endpoint": ws_url, "message": msg }),
            );
            return Ok(json!({ "ok": false, "error": { "message": msg } }));
        }
    };
    if let Ok(origin_val) = origin.parse() {
        request.headers_mut().insert("Origin", origin_val);
    }

    let connector = if profile.allow_insecure_tls.unwrap_or(false) {
        let mut builder = native_tls::TlsConnector::builder();
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
        builder.build().ok().map(Connector::NativeTls)
    } else {
        None
    };

    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(64 * 1024 * 1024),
        max_frame_size: Some(32 * 1024 * 1024),
        ..Default::default()
    };

    let ws_stream = match tokio::time::timeout(
        Duration::from_secs(10),
        connect_async_tls_with_config(request, Some(ws_config), false, connector),
    )
    .await
    {
        Ok(Ok((stream, _))) => stream,
        Ok(Err(e)) => {
            let msg = format!("WebSocket connection error: {}", e);
            let _ = app.emit(
                "gateway:status",
                json!({ "state": "error", "endpoint": ws_url, "message": msg }),
            );
            return Ok(json!({ "ok": false, "error": { "message": msg } }));
        }
        Err(_) => {
            let msg = "Connection timed out after 10s".to_string();
            let _ = app.emit(
                "gateway:status",
                json!({ "state": "error", "endpoint": ws_url, "message": msg }),
            );
            return Ok(json!({ "ok": false, "error": { "message": msg } }));
        }
    };

    let mut connection_tasks = state.connection_tasks.lock().await;
    if !state.is_current_connection(epoch) {
        return Ok(json!({ "ok": false, "cancelled": true }));
    }
    let (mut ws_sink, mut ws_source) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    *state.ws_tx.lock().await = Some(out_tx);

    let (challenge_tx, challenge_rx) = oneshot::channel::<Option<String>>();
    let mut challenge_tx_opt = Some(challenge_tx);

    // The connection owns both tasks, including the ping loop.
    connection_tasks.push(tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(Duration::from_secs(20));
        loop {
            tokio::select! {
                text = out_rx.recv() => {
                    let Some(text) = text else { break; };
                    if ws_sink.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                _ = ping_interval.tick() => {
                    if ws_sink.send(Message::Ping(vec![])).await.is_err() {
                        break;
                    }
                }
                else => break,
            }
        }
    }));

    // Reader task
    let state_clone = state.inner().clone();
    let app_clone = app.clone();
    let ws_url_clone = ws_url.clone();
    connection_tasks.push(tokio::spawn(async move {
        let mut close_reason = "Gateway connection closed".to_string();
        while let Some(msg_res) = ws_source.next().await {
            if !state_clone.is_current_connection(epoch) {
                return;
            }
            match msg_res {
                Ok(Message::Text(text)) => {
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    let frame_type = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if frame_type == "event" {
                        let ev_name = frame.get("event").and_then(|v| v.as_str()).unwrap_or("");
                        if ev_name == "connect.challenge" {
                            if let Some(tx) = challenge_tx_opt.take() {
                                let nonce = frame
                                    .get("payload")
                                    .and_then(|p| p.get("nonce"))
                                    .and_then(|n| n.as_str())
                                    .map(|s| s.to_string());
                                let _ = tx.send(nonce);
                            }
                            continue;
                        }
                        let _ = app_clone.emit("gateway:event", frame);
                    } else if frame_type == "res" {
                        if let Some(id) = frame.get("id").and_then(|v| v.as_str()) {
                            if let Some(sender) = state_clone.pending.lock().await.remove(id) {
                                let ok = frame.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                                if ok {
                                    let payload =
                                        frame.get("payload").cloned().unwrap_or(json!({}));
                                    let _ = sender.send(Ok(payload));
                                } else {
                                    let err_obj = frame
                                        .get("error")
                                        .cloned()
                                        .unwrap_or(json!({ "message": "RPC failed" }));
                                    let _ = sender.send(Err(err_obj));
                                }
                            }
                        }
                    }
                }
                Ok(Message::Close(close_frame)) => {
                    close_reason = close_frame
                        .map(|frame| frame.reason.to_string())
                        .filter(|reason| !reason.is_empty())
                        .unwrap_or(close_reason);
                    break;
                }
                Err(error) => {
                    close_reason = format!("Gateway connection interrupted: {error}");
                    break;
                }
                _ => {}
            }
        }
        state_clone
            .disconnect_connection(
                Some(epoch),
                Some((&app_clone, &ws_url_clone, &close_reason)),
            )
            .await;
    }));
    drop(connection_tasks);

    // Wait up to 900ms for connect.challenge
    let nonce_opt = match tokio::time::timeout(Duration::from_millis(900), challenge_rx).await {
        Ok(Ok(n)) => n,
        _ => None,
    };

    if !state.is_current_connection(epoch) {
        return Ok(json!({ "ok": false, "cancelled": true }));
    }

    let client_id = profile
        .client_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("gateway-client");
    let client_mode = profile
        .client_mode
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("ui");
    let role = profile
        .role
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("operator");
    let scopes = [
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.admin",
    ];
    let signed_at_ms = now_ms();
    let effective_token = authentication_token(&profile);
    let platform = "win32";
    let device_family = "windows";

    let mut auth_obj = serde_json::Map::new();
    if let Some(t) = profile
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        auth_obj.insert("token".to_string(), json!(t));
    }
    if let Some(p) = profile
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        auth_obj.insert("password".to_string(), json!(p));
    }
    if let Some(dt) = profile
        .device_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        auth_obj.insert("deviceToken".to_string(), json!(dt));
    }

    let mut connect_params = json!({
        "minProtocol": 3,
        "maxProtocol": 4,
        "client": {
            "id": client_id,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": platform,
            "deviceFamily": device_family,
            "mode": client_mode
        },
        "role": role,
        "scopes": scopes,
        "caps": [],
        "commands": [],
        "permissions": {},
        "locale": "en-US",
        "userAgent": format!("yaoc/{} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::ARCH)
    });

    if !auth_obj.is_empty() {
        connect_params["auth"] = Value::Object(auth_obj);
    }

    if profile.include_device_identity.unwrap_or(true) {
        if let Some(ref nonce) = nonce_opt {
            if let Ok(signature) = sign_device_challenge_v3(
                &state.identity,
                DeviceChallenge {
                    client_id,
                    client_mode,
                    role,
                    scopes: &scopes,
                    signed_at_ms,
                    token: effective_token,
                    nonce,
                    platform,
                    device_family,
                },
            ) {
                connect_params["device"] = json!({
                    "id": state.identity.device_id,
                    "publicKey": state.identity.public_key_base64_url,
                    "signature": signature,
                    "signedAt": signed_at_ms as u64,
                    "nonce": nonce
                });
            }
        }
    }

    match state.send_rpc("connect", connect_params, 12000).await {
        Ok(hello) => {
            if !state.is_current_connection(epoch) {
                return Ok(json!({ "ok": false, "cancelled": true }));
            }
            let _ = app.emit(
                "gateway:status",
                json!({
                    "state": "connected",
                    "endpoint": ws_url,
                    "hello": hello
                }),
            );
            Ok(json!({ "ok": true, "hello": hello }))
        }
        Err(err_val) => {
            if !state.is_current_connection(epoch) {
                return Ok(json!({ "ok": false, "cancelled": true }));
            }
            let msg = err_val
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Handshake failed")
                .to_string();
            let code = err_val
                .get("code")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let details = err_val.get("details").cloned();
            let lower = msg.to_lowercase();
            let is_pairing = lower.contains("pairing required")
                || lower.contains("not approved")
                || code.as_deref() == Some("NOT_PAIRED")
                || code.as_deref() == Some("PAIRING_REQUIRED");

            let _ = app.emit(
                "gateway:status",
                json!({
                    "state": if is_pairing { "pairing" } else { "error" },
                    "endpoint": ws_url,
                    "message": msg,
                    "code": code,
                    "details": details,
                    "deviceId": state.identity.device_id
                }),
            );
            state.disconnect_connection(Some(epoch), None).await;
            Ok(json!({ "ok": false, "error": err_val }))
        }
    }
}

#[tauri::command]
async fn gateway_request(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let epoch = state.connection_epoch.load(Ordering::SeqCst);
    let params_val = params.unwrap_or_else(|| json!({}));
    if *state.is_mock.lock().await {
        return handle_mock_request(&app, &state, &method, params_val).await;
    }

    match state
        .send_rpc(&method, params_val, timeout_ms.unwrap_or(15000))
        .await
    {
        Ok(payload) => Ok(payload),
        Err(err_val) => {
            if !state.is_current_connection(epoch) {
                return Err("Connection attempt was cancelled".to_string());
            }
            let msg = err_val
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Gateway RPC error")
                .to_string();
            Err(msg)
        }
    }
}

async fn handle_mock_request(
    app: &AppHandle,
    state: &Arc<GatewayState>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "agents.list" => Ok(json!({
            "defaultId": "main",
            "agents": [
                { "id": "main", "name": "OpenClaw Main", "workspace": "~/.openclaw/workspace" }
            ]
        })),
        "models.list" => Ok(json!({ "models": [
            { "id": "claude-sonnet-4-5", "provider": "anthropic", "name": "Claude Sonnet 4.5" },
            { "id": "gemini-2.5-pro", "provider": "google", "name": "Gemini 2.5 Pro" },
            { "id": "gpt-4.1", "provider": "openai", "name": "GPT-4.1" }
        ] })),
        "sessions.list" => {
            let overrides = state.mock_session_models.lock().await;
            let thinking = state.mock_session_thinking.lock().await;
            let labels = state.mock_session_labels.lock().await;
            let mut keys: Vec<String> = overrides.keys().cloned().collect();
            for key in thinking.keys().chain(labels.keys()) {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
            if !keys.iter().any(|key| key == "main") {
                keys.push("main".to_string());
            }
            keys.sort();
            let sessions: Vec<Value> = keys.iter().map(|key| {
                let model_ref = overrides.get(key).map(String::as_str).unwrap_or("anthropic/claude-sonnet-4-5");
                let (provider, model) = model_ref.split_once('/').unwrap_or(("anthropic", model_ref));
                let default_label = if key == "main" { "Primary Session" } else { key.as_str() };
                let label = labels.get(key).map(String::as_str).unwrap_or(default_label);
                json!({ "key": key, "agentId": "main", "label": label, "model": model, "modelProvider": provider, "thinkingLevel": thinking.get(key) })
            }).collect();
            Ok(json!({ "sessions": sessions }))
        }
        "sessions.patch" => {
            let key = params.get("key").and_then(Value::as_str).unwrap_or("main");
            let mut overrides = state.mock_session_models.lock().await;
            let mut thinking = state.mock_session_thinking.lock().await;
            let mut labels = state.mock_session_labels.lock().await;
            if let Some(value) = params.get("label") {
                if value.is_null() {
                    labels.remove(key);
                } else if let Some(label) = value.as_str() {
                    let trimmed = label.trim();
                    if trimmed.is_empty() {
                        labels.remove(key);
                    } else {
                        labels.insert(key.to_string(), trimmed.to_string());
                    }
                }
            }
            if let Some(value) = params.get("thinkingLevel") {
                if value.is_null() {
                    thinking.remove(key);
                } else {
                    let level = value
                        .as_str()
                        .ok_or("Reasoning effort must be a string or null")?;
                    if !["off", "minimal", "low", "medium", "high"].contains(&level) {
                        return Err("Unsupported reasoning effort".to_string());
                    }
                    thinking.insert(key.to_string(), level.to_string());
                }
            }
            if let Some(value) = params.get("model") {
                if value.is_null() {
                    overrides.remove(key);
                } else {
                    let model = value.as_str().ok_or("Model must be a string or null")?;
                    if ![
                        "anthropic/claude-sonnet-4-5",
                        "google/gemini-2.5-pro",
                        "openai/gpt-4.1",
                    ]
                    .contains(&model)
                    {
                        return Err("Model is not available in the demo Gateway".to_string());
                    }
                    overrides.insert(key.to_string(), model.to_string());
                }
            }
            let model_ref = overrides
                .get(key)
                .map(String::as_str)
                .unwrap_or("anthropic/claude-sonnet-4-5");
            let (provider, model) = model_ref
                .split_once('/')
                .unwrap_or(("anthropic", model_ref));
            Ok(
                json!({ "ok": true, "key": key, "entry": { "label": labels.get(key), "thinkingLevel": thinking.get(key) }, "resolved": { "model": model, "modelProvider": provider } }),
            )
        }
        "sessions.delete" => {
            let key = params.get("key").and_then(|v| v.as_str()).unwrap_or("main");
            state.mock_session_models.lock().await.remove(key);
            state.mock_session_thinking.lock().await.remove(key);
            state.mock_session_labels.lock().await.remove(key);
            Ok(json!({ "ok": true, "key": key }))
        }
        "sessions.reset" => Ok(json!({
            "ok": true,
            "key": params.get("key").and_then(|v| v.as_str()).unwrap_or("main")
        })),
        "chat.history" => {
            let session_key = params
                .get("sessionKey")
                .and_then(Value::as_str)
                .unwrap_or("main");
            Ok(json!({
                "sessionKey": session_key,
                "messages": [
                    {
                        "id": "welcome-tauri",
                        "role": "assistant",
                        "content": "Welcome to the YAOC demo. Messages and workspace edits stay in this process. Connect a Gateway to use an agent.",
                        "timestamp": now_ms() as u64
                    }
                ]
            }))
        }
        "agents.files.list" => {
            let files_map = state.mock_files.lock().await;
            let files: Vec<Value> = files_map
                .iter()
                .map(|(name, content)| {
                    json!({
                        "name": name,
                        "path": name,
                        "kind": "file",
                        "size": content.len(),
                        "missing": false
                    })
                })
                .collect();
            Ok(json!({
                "agentId": "main",
                "workspace": "~/.openclaw/workspace",
                "files": files
            }))
        }
        "agents.workspace.list" => {
            let files_map = state.mock_files.lock().await;
            let entries: Vec<Value> = files_map
                .iter()
                .map(|(name, content)| {
                    json!({
                        "name": name,
                        "path": name,
                        "kind": "file",
                        "size": content.len()
                    })
                })
                .collect();
            Ok(json!({ "agentId": "main", "path": "", "entries": entries }))
        }
        "agents.workspace.get" | "agents.files.get" => {
            let name = params
                .get("path")
                .or_else(|| params.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("AGENTS.md");
            let files_map = state.mock_files.lock().await;
            let content = files_map.get(name).cloned().unwrap_or_default();
            Ok(json!({
                "agentId": "main",
                "file": {
                    "name": name,
                    "path": name,
                    "size": content.len(),
                    "content": content
                },
                "content": content
            }))
        }
        "agents.files.set" | "sessions.files.set" => {
            let name = params
                .get("name")
                .or_else(|| params.get("path"))
                .and_then(|v| v.as_str())
                .unwrap_or("AGENTS.md")
                .to_string();
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            state
                .mock_files
                .lock()
                .await
                .insert(name.clone(), content.clone());
            Ok(json!({ "ok": true, "success": true, "path": name, "bytesWritten": content.len() }))
        }
        "chat.send" => {
            let run_id = format!("run-{}", now_ms());
            let user_msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let att_count = params
                .get("attachments")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let reply = if att_count > 0 {
                format!(
                    "Demo reply ({} attachment(s)):\n\n> {}",
                    att_count, user_msg
                )
            } else {
                format!("Demo reply:\n\n> {}", user_msg)
            };
            let _ = app.emit(
                "gateway:event",
                json!({
                    "type": "event",
                    "event": "chat",
                    "payload": {
                        "sessionKey": params.get("sessionKey").and_then(Value::as_str).unwrap_or("main"),
                        "agentId": params.get("agentId").and_then(Value::as_str).unwrap_or("main"),
                        "runId": run_id,
                        "state": "final",
                        "final": true,
                        "message": {
                            "id": format!("msg-{}", run_id),
                            "role": "assistant",
                            "content": reply,
                            "timestamp": now_ms() as u64
                        }
                    }
                }),
            );
            Ok(json!({ "accepted": true, "runId": run_id }))
        }
        _ => Ok(json!({ "ok": true })),
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    log_boot("quit_app command invoked; exiting process");
    app.exit(0);
}

// Re-read visibility, minimization, and focus on the main thread after window operations.
fn refresh_efficiency_mode(app: &AppHandle) {
    let app = app.clone();
    let dispatch = app.clone();
    if let Err(error) = dispatch.run_on_main_thread(move || {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        #[cfg(target_os = "windows")]
        let focused = window
            .hwnd()
            .map(|handle| efficiency::window_has_focus(handle.0 as isize))
            .unwrap_or(true);
        #[cfg(not(target_os = "windows"))]
        let focused = window.is_focused().unwrap_or(true);
        let background = !window.is_visible().unwrap_or(true)
            || window.is_minimized().unwrap_or(false)
            || !focused;
        match efficiency::set_background(background) {
            Ok(true) => log_boot(if background {
                "Background efficiency mode enabled (EcoQoS, idle priority)"
            } else {
                "Foreground CPU scheduling restored"
            }),
            Ok(false) => {}
            Err(error) => log_boot(&format!("Could not update efficiency mode: {error}")),
        }
    }) {
        log_boot(&format!("Could not schedule efficiency update: {error}"));
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_minimized = window.is_minimized().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);

        if is_visible && !is_minimized && is_focused {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_always_on_top(true);
            let _ = window.set_always_on_top(false);
            let _ = window.set_focus();
        }
        refresh_efficiency_mode(app);
    }
}

fn load_saved_global_hotkey() -> String {
    let path = get_storage_dir().join("gateway-profiles.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if let Some(hk) = val
                .get("uiState")
                .and_then(|u| u.get("globalHotkey"))
                .and_then(|h| h.as_str())
            {
                return hk.trim().to_string();
            }
        }
    }
    "Alt+Shift+3".to_string()
}

fn parse_win32_hotkey(raw: &str) -> Result<Option<(u32, u32, String)>, String> {
    const MOD_ALT: u32 = 0x0001;
    const MOD_CONTROL: u32 = 0x0002;
    const MOD_SHIFT: u32 = 0x0004;
    const MOD_WIN: u32 = 0x0008;

    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("disabled")
    {
        return Ok(None);
    }

    let mut mods: u32 = 0;
    let mut key_vk: Option<(u32, String)> = None;

    for part in trimmed
        .split('+')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let upper = part.to_ascii_uppercase();
        match upper.as_str() {
            "CTRL" | "CONTROL" => mods |= MOD_CONTROL,
            "ALT" | "OPTION" => mods |= MOD_ALT,
            "SHIFT" => mods |= MOD_SHIFT,
            "WIN" | "SUPER" | "META" | "CMD" => mods |= MOD_WIN,
            _ => {
                if key_vk.is_some() {
                    return Err(format!("Multiple non-modifier keys in shortcut: '{}'", raw));
                }
                let parsed_key = if upper.len() == 1 {
                    let ch = upper.chars().next().unwrap();
                    if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
                        Some((ch as u32, ch.to_string()))
                    } else {
                        match ch {
                            '`' | '~' => Some((0xC0, "`".to_string())),
                            '-' | '_' => Some((0xBD, "-".to_string())),
                            '=' => Some((0xBB, "=".to_string())),
                            '[' | '{' => Some((0xDB, "[".to_string())),
                            ']' | '}' => Some((0xDD, "]".to_string())),
                            '\\' | '|' => Some((0xDC, "\\".to_string())),
                            ';' | ':' => Some((0xBA, ";".to_string())),
                            '\'' | '"' => Some((0xDE, "'".to_string())),
                            ',' | '<' => Some((0xBC, ",".to_string())),
                            '.' | '>' => Some((0xBE, ".".to_string())),
                            '/' | '?' => Some((0xBF, "/".to_string())),
                            _ => None,
                        }
                    }
                } else if let Some(f_num) = upper.strip_prefix('F') {
                    if let Ok(n) = f_num.parse::<u32>() {
                        if (1..=12).contains(&n) {
                            Some((0x70 + (n - 1), format!("F{}", n)))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    match upper.as_str() {
                        "SPACE" | "SPACEBAR" => Some((0x20, "Space".to_string())),
                        "TAB" => Some((0x09, "Tab".to_string())),
                        "ENTER" | "RETURN" => Some((0x0D, "Enter".to_string())),
                        "BACKSPACE" => Some((0x08, "Backspace".to_string())),
                        "DELETE" | "DEL" => Some((0x2E, "Delete".to_string())),
                        "INSERT" | "INS" => Some((0x2D, "Insert".to_string())),
                        "HOME" => Some((0x24, "Home".to_string())),
                        "END" => Some((0x23, "End".to_string())),
                        "PAGEUP" | "PGUP" => Some((0x21, "PageUp".to_string())),
                        "PAGEDOWN" | "PGDN" => Some((0x22, "PageDown".to_string())),
                        "UP" | "ARROWUP" => Some((0x26, "Up".to_string())),
                        "DOWN" | "ARROWDOWN" => Some((0x28, "Down".to_string())),
                        "LEFT" | "ARROWLEFT" => Some((0x25, "Left".to_string())),
                        "RIGHT" | "ARROWRIGHT" => Some((0x27, "Right".to_string())),
                        "BACKQUOTE" | "GRAVE" => Some((0xC0, "`".to_string())),
                        "MINUS" => Some((0xBD, "-".to_string())),
                        "EQUAL" | "PLUS" => Some((0xBB, "=".to_string())),
                        "BRACKETLEFT" => Some((0xDB, "[".to_string())),
                        "BRACKETRIGHT" => Some((0xDD, "]".to_string())),
                        "BACKSLASH" => Some((0xDC, "\\".to_string())),
                        "SEMICOLON" => Some((0xBA, ";".to_string())),
                        "QUOTE" => Some((0xDE, "'".to_string())),
                        "COMMA" => Some((0xBC, ",".to_string())),
                        "PERIOD" => Some((0xBE, ".".to_string())),
                        "SLASH" => Some((0xBF, "/".to_string())),
                        _ => None,
                    }
                };
                match parsed_key {
                    Some(k) => key_vk = Some(k),
                    None => return Err(format!("Unsupported key '{}' in shortcut", part)),
                }
            }
        }
    }

    let (vk, key_label) = key_vk.ok_or_else(|| {
        "Shortcut must include a non-modifier key (e.g. 1, Space, A, F1)".to_string()
    })?;
    let is_func_key = (0x70..=0x7B).contains(&vk);
    if mods == 0 && !is_func_key {
        return Err(
            "Shortcut must include at least one modifier (Ctrl, Alt, Shift, or Win)".to_string(),
        );
    }

    let mut parts: Vec<String> = Vec::new();
    if (mods & MOD_CONTROL) != 0 {
        parts.push("Ctrl".to_string());
    }
    if (mods & MOD_ALT) != 0 {
        parts.push("Alt".to_string());
    }
    if (mods & MOD_SHIFT) != 0 {
        parts.push("Shift".to_string());
    }
    if (mods & MOD_WIN) != 0 {
        parts.push("Win".to_string());
    }
    parts.push(key_label);

    Ok(Some((mods, vk, parts.join("+"))))
}

struct HotkeyUpdateReq {
    hotkey: String,
    reply: std::sync::mpsc::Sender<Result<String, String>>,
}

struct HotkeyBridge {
    thread_id: u32,
    tx: std::sync::Mutex<std::sync::mpsc::Sender<HotkeyUpdateReq>>,
}

static HOTKEY_BRIDGE: std::sync::OnceLock<HotkeyBridge> = std::sync::OnceLock::new();

struct TrayHandles {
    tray: tauri::tray::TrayIcon,
    show_hide_item: tauri::menu::MenuItem<tauri::Wry>,
}

static TRAY_HANDLES: std::sync::OnceLock<std::sync::Mutex<TrayHandles>> =
    std::sync::OnceLock::new();

fn update_tray_hotkey_label(hotkey_label: &str) {
    if let Some(lock) = TRAY_HANDLES.get() {
        if let Ok(handles) = lock.lock() {
            let menu_text = if hotkey_label.trim().is_empty() {
                "Show / Hide YAOC".to_string()
            } else {
                format!("Show / Hide YAOC ({})", hotkey_label.trim())
            };
            let tooltip_text = if hotkey_label.trim().is_empty() {
                "YAOC".to_string()
            } else {
                format!("YAOC ({})", hotkey_label.trim())
            };
            let _ = handles.show_hide_item.set_text(menu_text);
            let _ = handles.tray.set_tooltip(Some(tooltip_text));
        }
    }
}

#[tauri::command]
async fn set_global_hotkey(hotkey: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || set_global_hotkey_blocking(hotkey))
        .await
        .map_err(|e| e.to_string())?
}

fn set_global_hotkey_blocking(hotkey: String) -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        extern "system" {
            fn PostThreadMessageW(id_thread: u32, msg: u32, w_param: usize, l_param: isize) -> i32;
        }
        const WM_APP_UPDATE_HOTKEY: u32 = 0x8001;

        let bridge = HOTKEY_BRIDGE
            .get()
            .ok_or_else(|| "Global hotkey listener is not initialized".to_string())?;
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        {
            let sender = bridge
                .tx
                .lock()
                .map_err(|_| "Hotkey channel lock poisoned".to_string())?;
            sender
                .send(HotkeyUpdateReq {
                    hotkey: hotkey.clone(),
                    reply: reply_tx,
                })
                .map_err(|_| "Hotkey listener thread is not running".to_string())?;
        }
        unsafe {
            PostThreadMessageW(bridge.thread_id, WM_APP_UPDATE_HOTKEY, 0, 0);
        }
        match reply_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(normalized)) => {
                update_tray_hotkey_label(&normalized);
                Ok(json!({ "ok": true, "hotkey": normalized }))
            }
            Ok(Err(err)) => Err(err),
            Err(_) => Err("Timed out updating global shortcut".to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hotkey;
        Err("Global hotkeys are only supported on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn spawn_global_hotkey_listener(app: AppHandle, initial_hotkey: String) {
    let (req_tx, req_rx) = std::sync::mpsc::channel::<HotkeyUpdateReq>();

    std::thread::spawn(move || {
        #[repr(C)]
        struct Point {
            x: i32,
            y: i32,
        }
        #[repr(C)]
        struct Msg {
            hwnd: *mut std::ffi::c_void,
            message: u32,
            w_param: usize,
            l_param: isize,
            time: u32,
            pt: Point,
        }

        #[link(name = "user32")]
        extern "system" {
            fn RegisterHotKey(
                hwnd: *mut std::ffi::c_void,
                id: i32,
                fs_modifiers: u32,
                vk: u32,
            ) -> i32;
            fn UnregisterHotKey(hwnd: *mut std::ffi::c_void, id: i32) -> i32;
            fn PeekMessageW(
                lp_msg: *mut Msg,
                hwnd: *mut std::ffi::c_void,
                w_msg_filter_min: u32,
                w_msg_filter_max: u32,
                w_remove_msg: u32,
            ) -> i32;
            fn GetMessageW(
                lp_msg: *mut Msg,
                hwnd: *mut std::ffi::c_void,
                w_msg_filter_min: u32,
                w_msg_filter_max: u32,
            ) -> i32;
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThreadId() -> u32;
        }

        const MOD_NOREPEAT: u32 = 0x4000;
        const WM_HOTKEY: u32 = 0x0312;
        const WM_APP_UPDATE_HOTKEY: u32 = 0x8001;
        const HOTKEY_ID: i32 = 1;

        unsafe {
            let mut msg: Msg = std::mem::zeroed();
            // Force creation of the thread message queue before publishing thread_id
            PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, 0);
            let thread_id = GetCurrentThreadId();
            let _ = HOTKEY_BRIDGE.set(HotkeyBridge {
                thread_id,
                tx: std::sync::Mutex::new(req_tx),
            });

            // Share the existing native message loop; no polling timer or extra thread.
            let callback_app = app.clone();
            let _foreground_listener = match efficiency::watch_foreground(move || {
                refresh_efficiency_mode(&callback_app);
            }) {
                Ok(listener) => Some(listener),
                Err(error) => {
                    log_boot(&format!(
                        "Could not initialize efficiency focus listener: {error}"
                    ));
                    None
                }
            };
            refresh_efficiency_mode(&app);

            let mut current_hotkey: Option<(u32, u32, String)> = None;

            if let Ok(Some((mods, vk, label))) = parse_win32_hotkey(&initial_hotkey) {
                if RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods | MOD_NOREPEAT, vk) != 0 {
                    log_boot(&format!("Registered global hotkey {}", label));
                    current_hotkey = Some((mods, vk, label));
                } else {
                    log_boot(&format!(
                        "WARNING: Failed to register global hotkey {}",
                        label
                    ));
                }
            }

            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_HOTKEY && msg.w_param == (HOTKEY_ID as usize) {
                    toggle_main_window(&app);
                } else if msg.message == WM_APP_UPDATE_HOTKEY {
                    while let Ok(req) = req_rx.try_recv() {
                        match parse_win32_hotkey(&req.hotkey) {
                            Ok(None) => {
                                if current_hotkey.is_some() {
                                    UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                                    current_hotkey = None;
                                }
                                let _ = req.reply.send(Ok(String::new()));
                            }
                            Ok(Some((mods, vk, label))) => {
                                if current_hotkey.is_some() {
                                    UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                                }
                                if RegisterHotKey(
                                    std::ptr::null_mut(),
                                    HOTKEY_ID,
                                    mods | MOD_NOREPEAT,
                                    vk,
                                ) != 0
                                {
                                    current_hotkey = Some((mods, vk, label.clone()));
                                    let _ = req.reply.send(Ok(label));
                                } else {
                                    // Restore previous hotkey if the new one is unavailable
                                    if let Some((old_mods, old_vk, _)) = &current_hotkey {
                                        RegisterHotKey(
                                            std::ptr::null_mut(),
                                            HOTKEY_ID,
                                            *old_mods | MOD_NOREPEAT,
                                            *old_vk,
                                        );
                                    }
                                    let _ = req.reply.send(Err(format!(
                                        "Could not register '{}' (it may already be in use by Windows or another app).",
                                        label
                                    )));
                                }
                            }
                            Err(e) => {
                                let _ = req.reply.send(Err(e));
                            }
                        }
                    }
                }
            }
        }
    });
}

fn setup_system_tray(
    app: &tauri::App,
    initial_hotkey: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{MenuBuilder, MenuItemBuilder},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_hide_label = if initial_hotkey.trim().is_empty() {
        "Show / Hide YAOC".to_string()
    } else {
        format!("Show / Hide YAOC ({})", initial_hotkey.trim())
    };
    let tooltip_label = if initial_hotkey.trim().is_empty() {
        "YAOC".to_string()
    } else {
        format!("YAOC ({})", initial_hotkey.trim())
    };

    let show_hide_item = MenuItemBuilder::with_id("show_hide", show_hide_label).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit YAOC").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_hide_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip(tooltip_label)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_hide" => {
                toggle_main_window(app);
            }
            "quit" => {
                log_boot("Tray Quit clicked; exiting process");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    let tray = tray_builder.build(app)?;
    let _ = TRAY_HANDLES.set(std::sync::Mutex::new(TrayHandles {
        tray,
        show_hide_item,
    }));
    Ok(())
}

fn log_boot(msg: &str) {
    let dir = get_storage_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("diagnostics.log");
    let line = format!("[{}] {}\n", now_ms(), msg);
    let should_truncate = fs::metadata(&path)
        .map(|m| m.len() > 256 * 1024)
        .unwrap_or(false);
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true);
    if should_truncate {
        opts.truncate(true);
    } else {
        opts.append(true);
    }
    if let Ok(mut f) = opts.open(path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn main() {
    log_boot("main() started");
    let gw_state = match GatewayState::new() {
        Ok(state) => Arc::new(state),
        Err(error) => {
            log_boot(&format!("Startup failed: {error}"));
            show_startup_error(&error);
            return;
        }
    };
    log_boot("GatewayState initialized");
    tauri::Builder::default()
        .manage(gw_state)
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if TRAY_HANDLES.get().is_none() {
                        return;
                    }
                    api.prevent_close();
                    let _ = window.hide();
                    refresh_efficiency_mode(window.app_handle());
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
                    refresh_efficiency_mode(window.app_handle());
                }
                _ => {}
            }
        })
        .setup(|app| {
            log_boot("tauri setup() hook called");
            let initial_hotkey = load_saved_global_hotkey();
            if let Err(err) = setup_system_tray(app, &initial_hotkey) {
                log_boot(&format!("WARNING: Failed to setup system tray: {}", err));
            }
            #[cfg(target_os = "windows")]
            spawn_global_hotkey_listener(app.handle().clone(), initial_hotkey);

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = window.set_icon(icon);
                }
                log_boot("found main window, calling show()");
                let _ = window.show();
                let _ = window.set_focus();
                log_boot("show() and set_focus() completed");
            } else {
                log_boot("WARNING: main window not found in setup()");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            load_profiles,
            save_profiles,
            gateway_connect,
            gateway_disconnect,
            gateway_request,
            set_global_hotkey,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_startup_error(message: &str) {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                window: *mut std::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                flags: u32,
            ) -> i32;
        }
        let text: Vec<u16> = format!("YAOC could not start.\n\n{message}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let caption: Vec<u16> = "YAOC".encode_utf16().chain(Some(0)).collect();
        // Both UTF-16 buffers remain valid for this synchronous call.
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10);
        }
    }
    #[cfg(not(target_os = "windows"))]
    eprintln!("YAOC could not start: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> GatewayState {
        GatewayState::with_identity(DeviceIdentity {
            device_id: String::new(),
            public_key_base64_url: String::new(),
            private_key_pem: String::new(),
            public_key_pem: String::new(),
        })
    }
    #[tokio::test]
    async fn disconnect_cancels_tasks_and_pending_requests() {
        let state = state();
        let (tx, _) = mpsc::unbounded_channel();
        *state.ws_tx.lock().await = Some(tx);
        let (response, waiting) = oneshot::channel();
        state
            .pending
            .lock()
            .await
            .insert("pending".into(), response);
        let task = tokio::spawn(std::future::pending::<()>());
        let cancelled = task.abort_handle();
        state.connection_tasks.lock().await.push(task);
        state.disconnect().await;
        tokio::task::yield_now().await;
        assert!(cancelled.is_finished());
        assert!(state.ws_tx.lock().await.is_none());
        assert!(waiting.await.unwrap().is_err());
    }
    #[tokio::test]
    async fn stale_reader_cannot_disconnect_a_new_connection() {
        let state = state();
        let old_epoch = state.connection_epoch.load(Ordering::SeqCst);
        state.disconnect().await;
        let (tx, _) = mpsc::unbounded_channel();
        *state.ws_tx.lock().await = Some(tx);
        assert!(!state.disconnect_connection(Some(old_epoch), None).await);
        assert!(state.ws_tx.lock().await.is_some());
    }
    #[test]
    fn hotkey_parser_and_url_normalization() {
        let hotkey = parse_win32_hotkey("Alt+Shift+3").unwrap().unwrap();
        assert_eq!(hotkey.1, b'3' as u32);
        assert_eq!(hotkey.2, "Alt+Shift+3");
        assert!(parse_win32_hotkey("Alt+Shift").is_err());
        assert_eq!(
            normalize_gateway_url(" https://example.com/gateway "),
            "wss://example.com/gateway"
        );
        assert_eq!(
            normalize_gateway_url("localhost:18789"),
            "ws://localhost:18789"
        );
    }
    #[test]
    fn websocket_origin_handles_ipv6_and_rejects_other_schemes() {
        assert_eq!(
            gateway_origin(&url::Url::parse("wss://[::1]:18789/path").unwrap()).unwrap(),
            "https://[::1]:18789"
        );
        assert!(gateway_origin(&url::Url::parse("ftp://example.com").unwrap()).is_err());
    }

    #[test]
    fn v3_signature_covers_the_canonical_challenge() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let identity = DeviceIdentity {
            device_id: "test-device".into(),
            public_key_base64_url: URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
            private_key_pem: key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            public_key_pem: String::new(),
        };
        let signature = sign_device_challenge_v3(
            &identity,
            DeviceChallenge {
                client_id: "gateway-client",
                client_mode: "ui",
                role: "operator",
                scopes: &["operator.read"],
                signed_at_ms: 42,
                token: "example-token",
                nonce: "example-nonce",
                platform: "win32",
                device_family: "windows",
            },
        )
        .unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(signature).unwrap();
        let signature = ed25519_dalek::Signature::from_slice(&bytes).unwrap();
        key.verifying_key().verify_strict(b"v3|test-device|gateway-client|ui|operator|operator.read|42|example-token|example-nonce|win32|windows", &signature).unwrap();
    }
}
