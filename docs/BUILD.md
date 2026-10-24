# Building YAOC on Windows

## Requirements

- Windows 10/11 x64 for the documented build environment.
- Node.js 22.12+ (Node.js 24 LTS recommended) and npm.
- Rust 1.90+ through rustup, using the `x86_64-pc-windows-gnullvm` host toolchain.
- LLVM-MinGW **UCRT**, with x64 and ARM64 tools on PATH.
- Microsoft Edge WebView2 Runtime to run the app. It is not required just to compile it.

Install Node.js LTS from its official distribution or WinGet, and Rust from rustup:

```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget --scope user
winget install --id Rustlang.Rustup -e --source winget
$env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH
rustup toolchain install stable-x86_64-pc-windows-gnullvm --profile minimal
rustup default stable-x86_64-pc-windows-gnullvm
rustup target add x86_64-pc-windows-gnullvm aarch64-pc-windows-gnullvm
rustup component add rustfmt clippy
```

Download the Windows x64 UCRT archive from the [LLVM-MinGW releases](https://github.com/mstorsjo/llvm-mingw/releases), verify its published SHA-256 digest, and extract its contents to `%LOCALAPPDATA%\Programs\llvm-mingw`. CI pins release `20261020`; its archive SHA-256 is `fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd`.

Open a new terminal after installation, or set PATH for the current session:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:LOCALAPPDATA\Programs\llvm-mingw\bin;" + $env:PATH
node --version
npm.cmd --version
cargo --version
x86_64-w64-mingw32-clang --version
aarch64-w64-mingw32-clang --version
```

## Checks

Run from the repository root:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run format:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm.cmd run dist:all
cargo test --locked --release --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnullvm
cargo clippy --locked --release --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnullvm -- -D warnings
```

Build before running Rust tests or Clippy on a fresh checkout: Tauri embeds `dist/` at compile time, and direct Cargo commands do not run the frontend build hook. CI builds both Beta executables before those checks.

Browser smoke tests run against compiled assets with an isolated mocked Gateway; they do not read profiles or connect to a real Gateway:

```powershell
npm.cmd exec playwright install chromium
npm.cmd run build:vite
npm.cmd run test:browser
```

If Chromium is already available separately, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that executable. Browser tests cover UI behavior, not native WebView2 rendering or Windows tray/hotkey registration. Test native startup, pairing, attachments, tray actions, and shortcuts on x64 and ARM64 Windows before an official release.

## Builds and packaging

```powershell
# Beta builds: one frontend build and timestamp shared by both targets.
npm.cmd run dist:all

# Or build one architecture.
npm.cmd run dist:x64
npm.cmd run dist:arm64

# Rebuild license notices, then stage both binaries and checksums.
npm.cmd run notices
npm.cmd run package:portable
```

`dist:*` creates Beta builds. Use `npm.cmd run release` only when preparing an official build; `release:x64` and `release:arm64` build a single official target. The version comes from `package.json`; Cargo and Tauri metadata must use the same version.

Raw executables are `src-tauri/target/<target-triple>/release/yaoc.exe`. Packaging writes `release/yaoc-x64.exe`, `release/yaoc-arm64.exe`, and `SHA256SUMS.txt`, with three rolling `.0.exe`/`.1.exe`/`.2.exe` backups. If Windows locks an old backup, quit that running instance before retrying. Distribute the project license and `THIRD_PARTY_LICENSES.txt` with the executables. The checked-in source tree excludes binaries and local build output.

The root `.cargo/config.toml` supplies both LLVM-MinGW linkers and `-C target-feature=+crt-static`. This avoids a separate `libunwind.dll`. The patched `webview2-com-sys` crate embeds the architecture-specific WebView2 loader. Windows system DLLs and the installed WebView2 Runtime remain runtime dependencies. Do not remove the patch or change `dragDropEnabled: false` without testing attachment drag-and-drop.

## Maintaining icons

Edit `src/assets/yaoc.svg` and run `npm.cmd run icons`. Sharp is a declared development dependency; generated PNG and ICO assets are checked in under `src-tauri/icons/`. Rebuild the app after changing them. The ICO contains 16, 24, 32, 48, 64, 128, and 256px images.

## Troubleshooting

- **Linker not found:** ensure the LLVM-MinGW `bin` directory is on the current PATH.
- **PowerShell blocks npm.ps1:** use `npm.cmd` as in these examples.
- **Frontend changes missing:** use an npm build command. Calling Cargo alone embeds the existing `dist/` assets.
- **WebView fails to start:** install/repair the Microsoft Edge WebView2 Runtime. Diagnostics are written to `%APPDATA%\openclaw-chat\diagnostics.log`; redact private data before sharing logs.
- **Shortcut already registered:** choose a different shortcut in Settings. Existing saved shortcuts override the default.
