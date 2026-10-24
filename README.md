# YAOC

**Yet Another OpenClaw Chat**, pronounced **yoke**, is an independent Windows desktop client for OpenClaw Gateways. It connects directly over WebSocket and uses the installed Microsoft Edge WebView2 Runtime rather than bundling a browser.

YAOC supports Windows x64 and ARM64. It is not an official OpenClaw application.

## Features

- Multiple Gateway profiles, device pairing, and cached device tokens.
- Streaming chat, reasoning traces, tool activity, and execution approvals.
- Image and file attachments through paste, drag-and-drop, or the attachment button.
- Agent/session switching, model selection, reasoning effort, and session actions.
- Gateway workspace browsing and editing, where the Gateway exposes those methods.
- Dark/light/system themes, resizable panels, a system tray icon, and a configurable global shortcut (default **Alt+Shift+3**).
- An offline demo for trying the interface without a Gateway.

## Getting started

Use `yaoc-x64.exe` for Intel/AMD Windows or `yaoc-arm64.exe` for Windows on ARM. These are portable executables; the **Microsoft Edge WebView2 Runtime must be installed**. Local build outputs are in `release/` and are excluded from the source repository. Published binaries, when available, belong in GitHub Releases.

Open Settings, select **Gateway Profiles**, and enter the Gateway endpoint and authentication details. The client accepts `http://`, `https://`, `ws://`, or `wss://` endpoints. Use TLS (`https://`/`wss://`) for remote connections, or connect through a trusted local tunnel. Self-signed certificate bypass is an explicit per-profile option and disables certificate verification.

On first connection, the Gateway may require device approval. Follow the pairing instructions in the app, or run these on the Gateway host:

```sh
openclaw devices list
openclaw devices approve <request-id>
```

For an offline preview, select **Built-in Demo Gateway (Offline Test)** and connect. Demo state is in memory; it is not a substitute for testing against a real Gateway.

Press **Enter** to send, **Shift+Enter** for a new line, **Ctrl+S** to save an open workspace file, and **Ctrl+,** for Settings. Closing the window normally hides it to the tray. Use **Ctrl+Q** or the tray's Quit command to exit.

## Development

The application uses React/TypeScript/Vite for the interface and Tauri v2/Rust for the native process. Windows x64 builds can cross-compile the ARM64 executable with LLVM-MinGW UCRT; Visual Studio C++ tools are not used by this build path.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run dist:all
npm.cmd run notices
npm.cmd run package:portable
```

These commands assume the Rust GNU/LLVM targets and LLVM-MinGW are installed. See [Build instructions](docs/BUILD.md) for setup, browser tests, Beta/official build modes, and packaging. See [Technical design](docs/TECHNICAL_DESIGN.md) for implementation details.

## Data and security

For compatibility with earlier builds, profiles and the device identity remain in `%APPDATA%\openclaw-chat\` (with a temporary-directory fallback if the normal environment variables are unavailable). **Saved authentication tokens, passwords, and the device private key are not encrypted by YAOC.** Protect that directory as sensitive user data, and do not attach it to issues or commit it to Git.

YAOC sends messages, attachments, and workspace changes to the selected Gateway. Model availability, workspace access, and execution approvals depend on that Gateway's version and permissions. See [Security](SECURITY.md) for the trust model and reporting guidance.

## Contributing and licensing

See [Contributing](CONTRIBUTING.md) for checks and contribution guidance. Third-party source and DLL notices are retained under `src-tauri/vendor/webview2-com-sys/`; distribution notices are generated as `THIRD_PARTY_LICENSES.txt`.

YAOC is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Lai Zit Seng. Third-party dependencies and the Microsoft WebView2 loader retain their respective licenses and notices.
