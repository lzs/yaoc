# YAOC — Technical Design & Architecture Document

This document describes the system architecture, wire protocol, component structure, and cross-compilation setup for contributors maintaining **YAOC**.

---

## 1. Architectural Overview

**YAOC** is a native Windows desktop client for **OpenClaw Gateways** targeting both **x64 (`x86_64-pc-windows-gnullvm`)** and **ARM64 (`aarch64-pc-windows-gnullvm`)**.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    React 18 + TypeScript Frontend (UI)                     │
│  src/main.tsx  ──►  src/tauriBridge.ts (window.openclawApi)  ──►  src/App.tsx│
└───────────────────────────────┬───────────────────────────────────▲────────┘
                                │ Tauri IPC (invoke)                │ Tauri Events
                                ▼                                   │ (gateway:status,
┌───────────────────────────────────────────────────────────────────┴────────┐
│                       Tauri v2 Rust Backend (src-tauri)                    │
│  src-tauri/src/main.rs                                                     │
│  ├─ GatewayState (DeviceIdentity, ws_tx, pending RPC map, mock state)      │
│  ├─ Ed25519 v3 Device Identity & Challenge Signer (ed25519-dalek + sha2)   │
│  ├─ Async WebSocket RPC Engine (tokio + tokio-tungstenite + native-tls)    │
│  └─ Offline Mock Gateway Engine (mock://demo)                              │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ WebSocket RPC (ws:// or wss://, Protocol v3–v4)
                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway Server (Local/Remote)                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### Tauri Frontend Bridge (`window.openclawApi`)

The application runs on **Tauri v2** (`src-tauri/`). The frontend communicates through the `window.openclawApi` abstraction defined in `src/types.ts`:

- In **Tauri v2**, `src/tauriBridge.ts` (`initTauriBridge()`) populates `window.openclawApi` using `window.__TAURI__.core.invoke` and `window.__TAURI__.event.listen`.
- Any new backend command added to `src-tauri/src/main.rs` should also be wired in `src/tauriBridge.ts` and `src/types.ts`.

---

## 2. Repository Directory Structure

```text
yaoc/
├── README.md                     # Project overview, walkthrough, feature list, and quick start
├── docs/
│   ├── BUILD.md                  # Step-by-step toolchain setup and x64/ARM64 build guide
│   └── TECHNICAL_DESIGN.md       # This technical design document
├── package.json                  # Frontend dependencies & build scripts
├── vite.config.ts                # Vite bundler config (outputs to dist/)
├── index.html                    # Root HTML entry point
├── release/                      # Output directory for portable single-file executables
│   ├── yaoc-x64.exe     # Portable Windows x64 executable
│   └── yaoc-arm64.exe   # Portable Windows ARM64 executable
├── src/                          # React + TypeScript Frontend
│   ├── main.tsx                  # Entry point; mounts <App />
│   ├── types.ts                  # Shared TypeScript interfaces & window.openclawApi contract
│   ├── models.ts                 # Model list normalization, session key scoping, & sessions.patch helper
│   ├── SessionModelSwitcher.tsx  # Per-session LLM model & reasoning effort (thinkingLevel) selector
│   ├── theme.ts                  # Dark / Light / System theme persistence & OS media query sync
│   ├── App.tsx                   # Tauri IPC bridge init, application state, RPC orchestration, and UI views
│   └── styles.css                # Complete CSS theme variables (dark/light), layout, resizers, & ClearType fonts
└── src-tauri/                    # Tauri v2 Rust Backend
    ├── Cargo.toml                # Rust dependencies & webview2-com-sys patch
    ├── build.rs                  # Embeds Common-Controls v6 + PerMonitorV2 DPI manifest
    ├── tauri.conf.json           # Tauri window config (withGlobalTauri: true, dragDropEnabled: false)
    ├── src/
    │   └── main.rs               # All Tauri commands, WebSocket RPC client, Ed25519 auth
    └── vendor/
        └── webview2-com-sys/     # Patched crate embedding x64/arm64/x86 WebView2Loader.dll
```

---

## 3. Rust Backend (`src-tauri/src/main.rs`)

### 3.1 Local Persistence (`%APPDATA%\openclaw-chat\`)

`get_storage_dir()` resolves to `%APPDATA%\openclaw-chat` (or `%TEMP%\openclaw-chat` if `APPDATA` is unset):

1. **`device-identity.json` (`DeviceIdentity`):**
   - Generated once on first run using `ed25519_dalek::SigningKey::generate(&mut OsRng)`.
   - Fields:
     - `deviceId`: Hex-encoded SHA-256 digest of the raw 32-byte Ed25519 public key (`sha2::Sha256`).
     - `publicKeyBase64Url`: Raw 32-byte Ed25519 public key encoded with `URL_SAFE_NO_PAD`.
     - `privateKeyPem`: PKCS#8 PEM-encoded private key.
     - `publicKeyPem`: SPKI PEM-encoded public key.
2. **`gateway-profiles.json`:**
   - Read by `load_profiles` and written by `save_profiles`.
   - Structure:
     ```json
     {
       "profiles": [ ... ],
       "activeProfileId": "local-default",
       "uiState": { ... }
     }
     ```
   - Each `GatewayProfile` in `profiles` stores `id`, `name`, `endpoint`, `token`, `password`, **`deviceToken`** (cached per profile when issued by the Gateway in `hello-ok`), `clientId`, `clientMode`, `role`, `allowInsecureTls`, and `includeDeviceIdentity`.
   - `uiState` (`UiSessionState`) persists `autoConnect`, `selectedAgentId`, `selectedSessionKey`, `showWorkspacePane`, `currentDir`, `activeFileName`, `showHiddenFiles`, `sidebarWidth`, `workspaceWidth`, and `workspaceTreeWidth` (also mirrored to `localStorage` under `openclaw.uiState.v1` for instant synchronous hydration, with disk writes debounced by 300 ms and written atomically via a `.tmp` file rename).

3. **`window-state.json` (`src-tauri/src/window_state.rs`):**
   - Stores the normal window position, client size, frame dimensions, display scale, and maximized state separately from frontend settings.
   - Move/resize/focus events update an in-memory snapshot; closing to the tray and exiting save it atomically. Minimizing preserves the previous normal bounds and maximized state.
   - Startup restores placement before showing the window. The saved bounds are fitted to an available monitor's work area, using the primary monitor if the saved display was disconnected and adjusting size for DPI changes. The existing minimum window size still applies.
   - Hidden/minimized state is never restored. Missing or invalid saved geometry falls back to the configured default window, with restore failures recorded in diagnostics.

### 3.2 OpenClaw Gateway WebSocket Protocol & Handshake

1. **Endpoint Normalization (`normalize_gateway_url`):**
   - Empty input defaults to `"ws://127.0.0.1:18789"`.
   - Converts `http://...` $\rightarrow$ `ws://...` and `https://...` $\rightarrow$ `wss://...`.
   - Bare `127.0.0.1...` or `localhost...` prefixes get `ws://`; other bare hostnames get `wss://`.
   - Synthesizes a matching `Origin` HTTP header (`http://host:port` for `ws://` or `https://host:port` for `wss://`) on the WebSocket upgrade request.
   - Configures WebSocket frame limits to `max_message_size: 64 MB` and `max_frame_size: 32 MB` to support large base64 attachments.
2. **Challenge-Response Handshake (`connect.challenge` $\rightarrow$ `connect`):**
   - Upon opening the WebSocket, the backend waits up to `900ms` for the Gateway to emit:
     ```json
     { "type": "event", "event": "connect.challenge", "payload": { "nonce": "..." } }
     ```
   - The backend resolves handshake parameters with the following exact defaults (`src-tauri/src/main.rs` lines 578–637):
     - `clientId`: `profile.client_id` or `"gateway-client"`
     - `clientMode`: `profile.client_mode` or `"ui"`
     - `role`: `profile.role` or `"operator"`
     - `scopes`: `["operator.read", "operator.write", "operator.approvals", "operator.admin"]` (exact order matters for signature verification)
     - `platform`: `"win32"`
     - `deviceFamily`: `"windows"`
     - `effective_token`: `profile.token` (if non-empty) else `profile.device_token` (if non-empty) else `""`
   - When `includeDeviceIdentity` is enabled (default `true`) and a challenge `nonce` was received, `sign_device_challenge_v3` signs the pipe-delimited v3 payload:
     ```text
     v3|{deviceId}|{clientId}|{clientMode}|{role}|{scopesCsv}|{signedAtMs}|{effectiveToken}|{nonce}|{platform}|{deviceFamily}
     ```
     using Ed25519 (`SigningKey::from_pkcs8_pem`) and encodes the 64-byte signature with `URL_SAFE_NO_PAD`.
   - The client sends the `connect` RPC request (`minProtocol: 3`, `maxProtocol: 4`):
     ```json
     {
       "minProtocol": 3,
       "maxProtocol": 4,
       "client": {
         "id": "gateway-client",
         "version": "<Cargo package version>",
         "platform": "win32",
         "deviceFamily": "windows",
         "mode": "ui"
       },
       "role": "operator",
       "scopes": ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
       "caps": [],
       "commands": [],
       "permissions": {},
       "locale": "en-US",
       "userAgent": "yaoc/<Cargo package version> (<arch>)",
       "auth": { "token": "...", "password": "...", "deviceToken": "..." },
       "device": {
         "id": "<deviceId>",
         "publicKey": "<publicKeyBase64Url>",
         "signature": "<base64UrlSignature>",
         "signedAt": 1700000000000,
         "nonce": "<nonce>"
       }
     }
     ```
   - **Handshake Outcomes:**
     - **Success (`hello-ok`):** Emits `gateway:status` with `state: "connected"` and `hello`. If `hello.auth.deviceToken` is present, `App.tsx` saves it into the active `GatewayProfile` in `gateway-profiles.json`.
     - **Pairing Required:** If the error code/message indicates `NOT_PAIRED`, `DEVICE_IDENTITY_REQUIRED`, `PAIRING_REQUIRED`, `not approved`, or `pending approval`, emits `gateway:status` with `state: "pairing"` and `deviceId` so the UI displays the pairing approval wizard and auto-polls every 4s.
3. **Multiplexed Request/Response & Keepalive:**
   - A dedicated writer task sends outbound JSON frames and a WebSocket `Ping` frame every 20 seconds.
   - `send_rpc` generates `req-{counter}-{timestamp_ms}`, stores a `oneshot::Sender` in `pending`, and awaits the matching `"type": "res"` frame with a configurable timeout (`timeoutMs`, default 30,000 ms; 12,000 ms for `connect`).
   - All non-challenge `"type": "event"` frames are emitted to the frontend via `app.emit("gateway:event", frame)`.

### 3.3 Tauri IPC Commands & Events

| Tauri Command        | Arguments                            | Return Type                               | Description                                                                                                                                                                      |
| :------------------- | :----------------------------------- | :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_system_info`    | _(none)_                             | `SystemInfo`                              | Returns `platform: "win32"`, `arch`, `runtime: "tauri-v2"`, and `deviceIdentity` (`deviceId`, `publicKey`).                                                                      |
| `load_profiles`      | _(none)_                             | `{ profiles, activeProfileId, uiState? }` | Loads profiles and UI state from `%APPDATA%\openclaw-chat\gateway-profiles.json` (or returns built-in defaults).                                                                 |
| `save_profiles`      | `profiles, activeProfileId, uiState` | `{ ok: boolean }`                         | Writes profiles and UI state to `%APPDATA%\openclaw-chat\gateway-profiles.json`.                                                                                                 |
| `gateway_connect`    | `profile: GatewayProfile`            | `Value`                                   | Connects to a live Gateway or starts `mock://demo` mode.                                                                                                                         |
| `gateway_disconnect` | _(none)_                             | `{ ok: boolean }`                         | Closes the active WebSocket connection and cancels pending requests.                                                                                                             |
| `gateway_request`    | `method, params, timeoutMs`          | `Value`                                   | Sends an RPC request over the active Gateway connection (or handles it in `handle_mock_rpc`).                                                                                    |
| `set_global_hotkey`  | `hotkey: String`                     | `{ ok: boolean, hotkey: string }`         | Dynamically unregisters/registers the Windows global shortcut (`RegisterHotKey` on the hotkey thread via `PostThreadMessageW`) and updates the system tray menu label & tooltip. |
| `quit_app`           | _(none)_                             | `()`                                      | Exits the Tauri process immediately (`app.exit(0)`), closing the system tray icon and background connection.                                                                     |

### 3.4 System Tray, Close-to-Tray & Customizable Global Shortcut (Default `Alt+Shift+3`)

- **Close-to-Tray (`on_window_event`):** When the tray initialized successfully, intercepts `WindowEvent::CloseRequested` on the main window, calls `api.prevent_close()`, and hides the window (`window.hide()`) so the WebSocket connection and streaming listeners continue running in the Windows system tray.
- **System Tray Icon & Context Menu (`setup_system_tray`):** Uses `tauri::tray::TrayIconBuilder` (`features = ["tray-icon"]`) with a left-click window toggle and a right-click menu containing **Show / Hide YAOC (<shortcut>)** and **Quit YAOC** (which calls `app.exit(0)` immediately).
- **Customizable Global Hotkey (`spawn_global_hotkey_listener` & `set_global_hotkey`):** Spawns a background thread calling Win32 `RegisterHotKey` and `GetMessageW` (`WM_HOTKEY`). Defaults to `Alt+Shift+3`, persisted in `uiState.globalHotkey` (`gateway-profiles.json`), and can be recorded, reset, or disabled live from **Settings $\rightarrow$ General**.
- **`Ctrl+Page Up/Down` Session Navigation:** Switches to the previous/next session in sidebar order, wrapping at either end. Reuses the existing session-selection path to preserve drafts and scroll state, scrolls the selected row into view, and focuses the composer. Navigation is suppressed during shortcut recording, composition, and modal dialogs.
- **`Ctrl+,` & `Ctrl+Q` In-Window Shortcuts:** Pressing `Ctrl+,` inside the window opens the Settings modal, and pressing `Ctrl+Q` opens a quit confirmation modal (press `Ctrl+Q` again to confirm quit via `quit_app`, or `Esc` to cancel).

### 3.5 Background efficiency mode

On Windows, the native host opts into EcoQoS and idle CPU priority while the main window is unfocused, minimized, or hidden in the tray. A visible, non-minimized window regaining focus restores the priority and execution-speed policy captured before entering background mode. The efficiency policy also applies to a visible window while another application has focus.

`src-tauri/src/efficiency.rs` wraps `GetProcessInformation`, `SetProcessInformation(ProcessPowerThrottling)`, and the process-priority APIs. A mutex serializes transitions; repeated background/foreground requests are idempotent. Failed changes are reported in diagnostics, with rollback or a retained restoration snapshot. Unsupported power policies are non-fatal. Unrelated power-throttling bits are preserved when restoring.

Window resize/focus events and the tray, close-to-tray, and global-shortcut paths recheck actual visibility, minimized state, and focus on the main thread. A native `EVENT_SYSTEM_FOREGROUND` listener shares the existing hotkey thread/message loop, covering focus changes before WebView2 starts delivering focus events without polling. Foreground ownership is checked through `GetForegroundWindow`/`GetAncestor`; YAOC-owned dialogs count as active. The native Gateway connection, WebView2 renderer, streaming handlers, and approvals stay running; the feature does not suspend the renderer, modify child-process priorities, or change transport timers. Task Manager controls how it displays Efficiency mode, and its indicator is not a measurement of energy savings.

A Windows regression test uses a separate child process to verify the real EcoQoS and priority flags, repeated transitions, and restoration without changing the scheduling of other tests. Both Windows architectures are built; native ARM64 behavior still requires validation on ARM hardware.

See [Windows efficiency mode](https://devblogs.microsoft.com/performance-diagnostics/reduce-process-interference-with-task-manager-efficiency-mode/) and [SetProcessInformation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation).

---

## 4. Frontend Architecture (`src/App.tsx` & `src/styles.css`)

### 4.1 Gateway RPC Methods & Fallback Flows Used by `App.tsx`

#### Agents, Models & Sessions

- `agents.list` `{}` $\rightarrow$ Lists available agents (`id`, `name`, `workspace`).
- `models.list` `{ agentId, sessionKey, view: "configured" }` (falls back to `{}` on older Gateways) $\rightarrow$ Lists available models (`id`, `provider`, `name`, `available`, `selectable`, and optional `thinkingLevels`/`thinkingDefault`) for [`SessionModelSwitcher.tsx`](../src/SessionModelSwitcher.tsx).
- `sessions.list` `{ agentId, limit: 100, includeDerivedTitles: true }` (falls back to `{ agentId, limit: 100 }`) $\rightarrow$ Lists sessions for the active agent (`key`, `sessionId`, `label`, `displayName`, `derivedTitle`, `model`, `modelProvider`, `thinkingLevel`, `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`, `updatedAt`).
- `sessions.patch` `{ key, label?, model?, thinkingLevel? }` $\rightarrow$ Updates a session's display label, model override (`provider/model` or `null` for agent default), or reasoning effort (an advertised option ID, or `null` to inherit the Gateway default). Short session keys for all agents, including `main`, are normalized via `toGatewaySessionKey(agentId, sessionKey)` (`agent:${agentId}:${sessionKey}`).
- `sessions.reset` `{ key }` $\rightarrow$ Resets a session transcript (equivalent to `/reset`).
- `sessions.delete` `{ key, deleteTranscript: true }` $\rightarrow$ Deletes a session and its transcript.

#### Chat & Attachments

- `chat.history` `{ sessionKey, limit: 100 }` $\rightarrow$ Fetches message history for a session, extracting text blocks, thinking traces, and image/file attachments.
- `chat.send` `{ sessionKey, message, idempotencyKey, attachments? }` $\rightarrow$ Sends a user message and optional attachments:
  ```ts
  attachments: [
    {
      type: att.isImage ? 'image' : 'file',
      fileName: att.fileName,
      mimeType: att.mimeType,
      content: att.base64, // raw base64 without data: URL prefix
    },
  ];
  ```
  - **Client-side Image Normalization (`readFileAsAttachment`):** Non-GIF raster images larger than `4.6 MiB` or `3840px` on either axis are scaled to at most `2560px` and encoded as JPEG at 0.86 quality through HTML canvas. SVG and GIF attachments bypass resizing. Gateway limits still apply to the encoded payload.
  - **Non-image Attachments:** PDFs and other files up to 20 MB are base64-encoded and sent with `type: 'file'`. Support for non-image attachments and how they are stored depend on the Gateway. If the user sends attachments with an empty text box, `App.tsx` automatically populates `[Attached: filename.ext]`.
- `chat.abort` `{ sessionKey, runId? }` $\rightarrow$ Aborts an in-flight assistant run.

#### Workspace Files (`loadWorkspaceFilesList`, `loadWorkspaceFile`, `handleSaveWorkspaceFile`)

OpenClaw Gateways expose two tiers of file APIs depending on server version and capabilities:

1. **Listing Files (`loadWorkspaceFilesList`):**
   - First calls `agents.files.list` `{ agentId }` to discover the `workspace` root path (e.g., `/home/openclaw/.openclaw/workspace`) and build a size map for root files.
   - Next calls `agents.workspace.list` `{ agentId, path?: cleanDir }` to list full directory trees (both files and subdirectories).
   - If `agents.workspace.list` is unsupported by the Gateway, falls back to the flat file list from `agents.files.list` `{ agentId }`, and finally to `STANDARD_WORKSPACE_FILES` (`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`).
2. **Reading a File (`loadWorkspaceFile`):**
   - First calls `agents.workspace.get` `{ agentId, path: cleanRelPath }`, which can read any file in the workspace root or subdirectories.
   - If that fails, falls back to `agents.files.get` `{ agentId, name: cleanRelPath }` (which has a strict schema accepting only `agentId` + root `name`).
3. **Saving / Creating a File (`handleSaveWorkspaceFile`):**
   - If the file is in the workspace root (`!cleanRelPath.includes('/')`), first attempts `agents.files.set` `{ agentId, name: cleanRelPath, content }`.
   - If the file is in a subdirectory (or `agents.files.set` rejects non-standard root filenames), falls back to `sessions.files.set` `{ sessionKey, path: "${workspaceRootPath}/${cleanRelPath}", content }`.

#### Tool Execution Approvals

- Subscribes to `exec.approval.requested` and `exec.approval.resolved` events and resolves pending prompts via `exec.approval.resolve` `{ id, decision: "allow-once" | "allow-always" | "deny" }`.

### 4.2 Important UI / WebView2 Implementation Details

1. **HTML5 Drag-and-Drop (`dragDropEnabled: false`):**
   - In `src-tauri/tauri.conf.json`, `"dragDropEnabled": false` is **intentionally set** on the window configuration.
   - Tauri v2's native file-drop handler intercepts OS drag events by default and blocks standard DOM `onDragOver` / `onDrop` `e.dataTransfer.files` access in WebView2. Setting `"dragDropEnabled": false` allows `App.tsx` to read dropped `File` objects directly in WebView2 via `FileReader` (`readAsDataURL`).
2. **Per-App-Run Session Scroll Memory & Smart Auto-Scroll:**
   - `visitedSessionsRef` and `sessionScrollTopRef` track which sessions have been viewed during the current app run and their last `scrollTop` offset.
   - When `loadChatHistory` resolves and calls `setMessages(mapped)`, it queues `pendingScrollActionRef` so `useLayoutEffect([messages])` runs at the exact render when the new session's messages mount:
     - **First visit to a session in the current app run:** Jumps immediately to the bottom (`el.scrollTop = el.scrollHeight`) and holds a 600 ms bottom lock (`initialBottomLockUntilRef`) so inline `<img className="message-image-thumb">` attachments that finish decoding right after mount keep the viewport pinned at the bottom.
     - **Subsequent visits to an already-seen session in the current app run:** Restores the exact `scrollTop` offset saved when the user was last in that session, even if new messages arrived while they were in another session.
   - During streaming updates within the same session, auto-scroll only triggers if the user is already near the bottom (`distanceFromBottom < 150px`) or just sent a message, allowing users to scroll up and read history undisturbed while responses stream in.
3. **Markdown Rendering & Per-Message Raw/Markdown Toggle:**
   - `src/markdown.tsx` provides `hasMarkdownSyntax(text)` and `<MarkdownContent content={text} />` (supporting fenced code blocks with one-click Copy, inline code, headings, bold/italic/strikethrough, links, blockquotes, lists/task lists, horizontal rules, and GFM tables).
   - Messages containing Markdown render formatted Markdown by default and display a **`Raw` / `Markdown`** toggle pill in `.message-header` so users can inspect the raw text of any individual message.
4. **Live Session Streaming Indicator & Unread Badge:**
   - Because all Gateway `chat` and `agent` events arrive over the single WebSocket connection regardless of which session is active in the UI, `App.tsx` normalizes every event's `sessionKey` into a full gateway key (`agent:<id>:<key>`) and tracks `streamingSessionKeys` and `unreadSessionKeys`.
   - **Streaming Spinner (`.session-status-spinner`):** Shown in a dedicated left slot (`.session-status-slot`) beside any session name in the left sidebar as a red spinning ring while `chat` (`state: 'delta'`) or `agent` (`lifecycle: 'start'` / `'Assistant'` / `'Tool'`) events are actively streaming in that session, and cleared automatically when `state: 'final'`, `'aborted'`, `'error'`, or `lifecycle: 'end'` arrives (with a 45s safety expiry timer).
   - **Unread Dot (`.session-status-dot`):** Shown as a solid red circle in `.session-status-slot` when a message arrives in a session that is not currently active, or in the active session while the user is scrolled up (`distanceFromBottom > 150px`) or the app window is unfocused (`!document.hasFocus()`). Automatically clears when the user switches to the session (at the bottom), scrolls down to the bottom, or focuses the window while viewing the bottom of the active session.
5. **Resizable Sidebars & Theme System:**
   - Left sidebar (`sidebarWidth`, 180px–560px, default 270px), right workspace drawer (`workspaceWidth`, 300px–1000px, default 560px), and workspace file tree (`workspaceTreeWidth`, 120px–600px, default 210px) are resizable via `.pane-resizer` drag handles and persisted in `uiState`.
   - `src/theme.ts` manages `dark`, `light`, and `system` themes (stored in `localStorage["openclaw.theme.v1"]`), applying `data-theme="dark" | "light"` to `document.documentElement`; the stylesheet sets the corresponding `color-scheme`.
6. **Typography & High-DPI Sharpness:**
   - `src/styles.css` uses system sans-serif and monospace font stacks (`--font-sans` and `--font-mono`) **without** `-webkit-font-smoothing: antialiased`. On Windows Chromium/WebView2, `-webkit-font-smoothing: antialiased` disables ClearType RGB subpixel rendering and forces softer grayscale anti-aliasing.
   - `src-tauri/build.rs` embeds `<dpiAware>true/pm</dpiAware>` and `<dpiAwareness>PerMonitorV2, PerMonitor</dpiAwareness>` into the PE executable manifest so Windows never bitmap-scales the window on 125% / 150% / 200% displays.

---

## 5. Build & Cross-Compilation Guide (x64 & ARM64)

### 5.1 Toolchain Architecture

The project uses Rust's `*-pc-windows-gnullvm` targets paired with the **LLVM-MinGW UCRT** toolchain (`x86_64-w64-mingw32-clang` and `aarch64-w64-mingw32-clang`). This allows building **both x64 and ARM64 native Windows executables** from a single machine without requiring Visual Studio C++ ARM64 build tools.

- **Rustup Targets:**
  - `x86_64-pc-windows-gnullvm`
  - `aarch64-pc-windows-gnullvm`

### 5.2 Patched `webview2-com-sys` Crate (`src-tauri/vendor/webview2-com-sys`)

Upstream `webview2-com-sys` attempts to link against MSVC-compiled `WebView2LoaderStatic.lib` (which fails under `llvm-mingw` / GNU linkers on `aarch64-pc-windows-gnullvm`) or requires shipping an external `WebView2Loader.dll` alongside the executable.

- To keep `yaoc-x64.exe` and `yaoc-arm64.exe` **single-executable portable builds**, we vendored `webview2-com-sys` in `src-tauri/vendor/webview2-com-sys` (wired via `[patch.crates-io]` in `src-tauri/Cargo.toml`):
  1. `src-tauri/vendor/webview2-com-sys/build.rs` only links `advapi32` and skips `WebView2LoaderStatic.lib`.
  2. `src-tauri/vendor/webview2-com-sys/src/lib.rs` (`mod embedded_loader`) embeds the architecture-specific `WebView2Loader.dll` (`../x64/WebView2Loader.dll`, 162 KB; `../arm64/WebView2Loader.dll`, 152 KB; `../x86/WebView2Loader.dll`) directly into the binary via `include_bytes!`.
  3. On first WebView2 call at runtime, `embedded_loader` writes the embedded DLL to a private per-process directory under `%LOCALAPPDATA%\yaoc\WebView2Loader`, validates the bytes under a read lock, loads it via restricted `LoadLibraryExW`, and forwards the four WebView2 loader entry points (`CompareBrowserVersions`, `CreateCoreWebView2Environment`, `CreateCoreWebView2EnvironmentWithOptions`, `GetAvailableCoreWebView2BrowserVersionString`) via `GetProcAddress`.
- **Do not remove `[patch.crates-io]`** from `src-tauri/Cargo.toml`, as it is required for single-file portability and `aarch64-pc-windows-gnullvm` compilation.

### 5.3 Build Commands

- **Beta / Development Builds:** `npm run dist:all` (or `npm run dist:x64` / `npm run dist:arm64`)
- **Official Release Builds:** `npm run release` (or `npm run release:x64` / `npm run release:arm64`)

### Session-scoped composer and run state

The composer keeps text and attachments per Gateway profile and agent/session key in memory. Switching sessions restores that session's draft, including when attachment reads finish after a switch. The send/stop control derives its busy state from `streamingSessionKeys`, the same state used by sidebar spinners. Run IDs are retained per session for abort requests. Chat terminal events, agent lifecycle end/error events, the existing 45-second inactivity timeout, and connection loss clear the corresponding busy state. Delayed send failures are never added to a different session's transcript, and history responses are discarded if their session is no longer selected.

### YAOC branding and compatibility

YAOC (pronounced “yoke”) expands to “Yet Another OpenClaw Chat”. The npm and Cargo package name is `yaoc`; raw Cargo output is `yaoc.exe`, and portable binaries are `yaoc-x64.exe` and `yaoc-arm64.exe` with three rolling backups each. The workspace directory is named `yaoc`.

The existing `%APPDATA%\openclaw-chat` (or `%TEMP%\openclaw-chat`) data directory, `ai.openclaw.chat.lite` Tauri/WebView2 identifier, and browser storage keys remain stable compatibility identifiers. This preserves saved profiles, device identity, cached pairing tokens, theme, hotkeys and UI settings without a data migration. The embedded WebView2 loader patch is retained; its private extraction directory is `%LOCALAPPDATA%\yaoc\WebView2Loader`.

YAOC uses a wide, softly rounded orange Y/yoke mark on a transparent background, defined in `src/assets/yaoc.svg`, in the header, welcome screen, and browser favicon. `scripts/generate-icons.cjs` renders that vector with Sharp into the PNGs and multi-resolution ICO in `src-tauri/icons`. Tauri embeds those assets for the executable, window/taskbar, and system tray (via `default_window_icon`). The OpenClaw lobster is not used as the client icon.

### Reliability and publication tooling

Connection epochs identify the active transport. Each connection owns its reader/writer tasks; disconnect aborts them, clears the sender, and fails pending RPCs. A stale reader cannot tear down a newer connection, and connection attempts are serialized. Reader failures produce a disconnected status. Global hotkey registration uses a blocking worker rather than waiting on the UI thread.

`src-tauri/src/storage.rs` writes through unique, synced temporary files in the destination directory and atomically renames them. Write errors reach the frontend. A damaged saved identity is reported rather than silently replaced; failed profile loads disable autosave so the original file is preserved. Diagnostics are bounded and stored alongside the user settings.

The production CSP allows bundled scripts and the Tauri IPC endpoint, with inline styles for React and HTTP(S)/data/blob image previews. The development policy separately allows Vite's local HMR connection. This complements React's escaped Markdown rendering; it does not make an untrusted Gateway safe.

Public build/test commands live in `package.json`. `scripts/package-portable.cjs` stages both lowercase binaries, rotates three backups, and writes SHA-256 checksums. `scripts/third-party-notices.cjs` gathers installed package notices. GitHub CI verifies the source and builds both Windows targets. See `SECURITY.md`, `CONTRIBUTING.md`, and `docs/BUILD.md` for operational guidance and remaining runtime validation requirements.

### Project licensing and settings persistence

YAOC is MIT-licensed; npm and Cargo metadata and the root `LICENSE` agree. The metadata check verifies this alongside the app version. Packaging requires the project license and third-party notices before rotating binaries, and includes both files in `release/`. Third-party terms remain separate.

Profile controls update React state; the guarded, debounced settings effect persists changes and reports errors. Direct disconnect persistence uses the same successful-load guard. A failed initial load keeps disk writes disabled, including when profiles are added in Settings.

### Gateway reasoning choices

Session rows and matching model defaults may advertise `thinkingLevels` (`{ id, label }` choices), legacy `thinkingOptions`, and `thinkingDefault`. YAOC preserves advertised IDs, labels, and order; session metadata takes precedence over the current model catalog. Defaults from a different model are not reused. Model changes clear stale metadata and refresh session choices. Older Gateways fall back to the existing compatibility levels; an explicit empty list stays empty.

The reasoning popup presents Default (clear the override), None (the advertised `off`/`none` ID), and Adaptive as separate buttons. Unsupported modes are disabled. Ordered effort levels appear on the slider; a model with one remaining choice uses a button instead. The selected mode is highlighted and mutes the slider; selecting a fixed level highlights the slider. Changing effort submits through `sessions.patch`, with rollback on rejection and connection/session guards for delayed replies. Gateway-provided defaults are shown separately from an explicit session selection.

### Canonical session identity

YAOC scopes short session names to `agent:<agentId>:<name>` for every agent, including `main`. New sessions store the qualified key and retain the typed name as a display label. Persisted selections and Gateway lists are normalized; short/qualified aliases collapse to one row while retaining human labels and authoritative Gateway metadata. Sending, history, aborts, drafts, scroll positions, streaming indicators, and unread state share this identity. Events derive their agent from a qualified key even when `agentId` is omitted, preventing cross-agent rows and replies. Creating an existing alias selects it instead of clearing its transcript. Unscoped `global`/`unknown` keys remain unchanged.

Named session keys are folded to lowercase before storage, comparison, and RPCs, matching Gateway identity rules (`SoCLaaS` and `soclaas` share one identity). Typed display labels retain their case, including when a list refresh omits a label. Signal group IDs and Matrix room/event IDs retain their provider-owned case so distinct external conversations are not merged.

Creating a session while connected also sends `sessions.patch` with the canonical key and the original display label. The Gateway therefore owns the label and capitalization, which YAOC reads back from `sessions.list` after restarting. Selecting an existing session does not overwrite its label. A rejected or failed label write leaves the local session usable and reports that the name was not saved. Offline creation remains local until the user saves its label with Rename while connected.
