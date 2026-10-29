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

# Rebuild notices, package both NSIS installers, then stage their identical portable payloads.
npm.cmd run notices
npm.cmd run package:installers
```

`dist:*` creates Beta builds. Use `npm.cmd run release` only when preparing an official build; `release:x64` and `release:arm64` build a single official target. The version comes from `package.json`; Cargo and Tauri metadata must use the same version.

Official releases use `major.minor.patch`, such as `2026.1.0`. Normal builds use `major.minor.patch-devMMDDHHMM`, for example `2026.1.0-dev01272005` for January 27 at 20:05 in the build machine's local time. The `dev` prefix keeps zero-padded months valid in SemVer. YAOC retains its calendar convention: the first component is the year and the second is the major version within that year. Settings > About contains the build details and a Beta / Testing or Official Release badge; the version has no `v` prefix or word `beta`.

The Vite build generates one timestamp for both architectures. After emitting the frontend, `scripts/sync-version.cjs` stamps the same full version into `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` before Cargo runs. These files retain the most recent build version, so the UI, native Gateway identification, and Tauri metadata match. Subsequent builds replace the suffix; official builds remove it. Builds therefore update tracked version metadata. To bump the base version, update the matching manifests and lockfiles together; `npm.cmd run check` verifies consistency.

Raw executables are `src-tauri/target/<target-triple>/release/yaoc.exe`. Packaging writes `release/yaoc-x64.exe`, `release/yaoc-arm64.exe`, and `SHA256SUMS.txt`, with three rolling `.0.exe`/`.1.exe`/`.2.exe` backups in `release/archive/`. A still-running oldest image is moved to `release/archive/.in-use` until a later packaging run can remove it. `package:installers` also writes `yaoc-x64-setup.exe` and `yaoc-arm64-setup.exe`; it captures the patched/signed NSIS payload so the portable executable matches byte-for-byte. See [UPDATES.md](UPDATES.md) for signing configuration and native acceptance commands. Distribute the project license and `THIRD_PARTY_LICENSES.txt` with the executables. The checked-in source tree excludes binaries and local build output.

The root `.cargo/config.toml` supplies both LLVM-MinGW linkers and `-C target-feature=+crt-static`. This avoids a separate `libunwind.dll`. The patched `webview2-com-sys` crate embeds the architecture-specific WebView2 loader. Windows system DLLs and the installed WebView2 Runtime remain runtime dependencies. Do not remove the patch or change `dragDropEnabled: false` without testing attachment drag-and-drop.

## Pre-release validation

Start with `npm.cmd ci` so installed frontend tools match the lockfile. Run the checks above, `npm.cmd audit`, and `cargo audit --file src-tauri/Cargo.lock`; inspect informational advisories against the actual Windows dependency graph. Regenerate notices with `npm.cmd run notices`; a missing license text fails generation and must be resolved before packaging.

Keep test builds in Beta until native validation is complete. On Windows 11 ARM64, launch `release/yaoc-arm64.exe` from a clean directory alongside the distribution notices and confirm its About version matches the build being tested. Check the integrated header, dragging/resizing, maximize/restore, minimize, close-to-tray, global shortcut, and restart geometry in both themes.

Use a dedicated test session and disposable workspace file for real-Gateway testing: pairing/reconnect, streaming and stop, attachments, approvals, model/reasoning changes, and workspace save/load. Also switch sessions while Reset is pending, and switch files or reconnect while Save is pending; completion must not replace another transcript, saved baseline, or Gateway's data. Native ARM64 and real-Gateway checks require manual validation when the build machine cannot provide them.

After validation, explicitly build the official version, regenerate notices, package both architectures, verify `SHA256SUMS.txt`, and publish the intended commits and artifacts. Official packaging requires Tauri updater signing configuration; see UPDATES.md. Windows Authenticode is deliberately not used for either official or Beta builds. Beta artifacts and official artifacts must not be mixed.

## Maintaining icons

Edit `src/assets/yaoc.svg` and run `npm.cmd run icons`. Sharp is a declared development dependency; generated PNG and ICO assets are checked in under `src-tauri/icons/`. Rebuild the app after changing them. The ICO contains 16, 24, 32, 48, 64, 128, and 256px images.

## Troubleshooting

- **Linker not found:** ensure the LLVM-MinGW `bin` directory is on the current PATH.
- **PowerShell blocks npm.ps1:** use `npm.cmd` as in these examples.
- **Frontend changes missing:** use an npm build command. Calling Cargo alone embeds the existing `dist/` assets.
- **WebView fails to start:** install/repair the Microsoft Edge WebView2 Runtime. Diagnostics are written to `%APPDATA%\yaoc\diagnostics.log`; redact private data before sharing logs.
- **Shortcut already registered:** choose a different shortcut in Settings. Existing saved shortcuts override the default.
