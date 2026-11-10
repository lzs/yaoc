# Building YAOC on Windows

## Build channel policy

The owner agreed on these channel names and defaults on 2026-11-09:

| Channel  | Intended use                                                       | Signing and packaging                                                     |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Canary   | Routine local development and testing; the default for coding work | Unsigned x64/ARM64 portable executables; no installers                    |
| Beta     | Prerelease distribution, when requested                            | Signed executables and installers                                         |
| Official | Explicitly requested stable release                                | Signed executables and installers, with separate Tauri updater signatures |

Canary versions retain `major.minor.patch-devMMDDHHMM`. After releasing a stable patch, development moves to the next patch base (for example, released `2026.1.1` → development `2026.1.2-dev…`). The channel badge is separate from this version string.

`scripts/build-local.ps1` implements these channels with `-Channel Canary|Beta|Official` (default Canary; `-Official` remains an alias for `-Channel Official`). Canary skips Authenticode and installer packaging, rejects `-Sign`, and stages both unsigned portable executables with `package:portable` and the three-generation backup rotation; installer outputs left from an earlier Beta/Official run are moved to `release/archive/retired-installers-*` so `SHA256SUMS.txt` only covers the new build. The wrapper also sets `YAOC_BUILD_CHANNEL` (`canary` or `beta`) for the frontend build, which stamps the Settings > About badge; direct `npm run dist:*` builds without it are Canary, and `npm run release` is always Official.

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

## Local builds from a network source checkout

Keep the source checkout, documents, and agent instructions on the network drive. Run the build in `%USERPROFILE%\Documents\Builds\yaoc` on the local disk:

```powershell
# Canary (default): unsigned portable executables only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-local.ps1
# Beta distribution, when requested: signed executables and installers.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-local.ps1 -Channel Beta -Sign
```

The script copies source inputs, installs dependencies locally, runs checks and browser tests, and builds both architectures. Canary then stages both unsigned portable executables and ZIPs; Beta and Official also package the combined installer. Its local `release/` directory retains the three rolling backup generations. Network `node_modules/`, `dist/`, `src-tauri/target/`, and `release/` directories are excluded from the copy. Only version manifests, lockfiles, and generated license notices are copied back to the source checkout, and concurrent source edits are preserved with a warning. Existing network build outputs can be retired separately.

The local folder is a build workspace; edit source in the network checkout and rerun the script to refresh it. Source mirroring removes stale source files locally while preserving the excluded dependency, build, and release directories. `run-app.bat` launches the local portable executable and runs this workflow if the executable is missing. The commands below should be run in the local build workspace.

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

# Rebuild notices, package one NSIS installer with both native builds, then stage portable payloads.
npm.cmd run notices
npm.cmd run package:installers
```

`dist:*` creates Beta builds. Use `npm.cmd run release` only when preparing an official build; `release:x64` and `release:arm64` build a single official target. The version comes from `package.json`; Cargo and Tauri metadata must use the same version.

Official releases use `major.minor.patch`, such as `2026.1.0`. Normal builds use `major.minor.patch-devMMDDHHMM`, for example `2026.1.0-dev01272005` for January 27 at 20:05 in the build machine's local time. The `dev` prefix keeps zero-padded months valid in SemVer. YAOC retains its calendar convention: the first component is the year and the second is the major version within that year. Settings > About contains the build details and a Canary, Beta, or Official Release badge (set by `YAOC_BUILD_CHANNEL` for non-official builds, default Canary); the version has no `v` prefix or word `beta`.

The Vite build generates one timestamp for both architectures. After emitting the frontend, `scripts/sync-version.cjs` stamps the same full version into `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` before Cargo runs. These files retain the most recent build version, so the UI, native Gateway identification, and Tauri metadata match. Subsequent builds replace the suffix; official builds remove it. Builds therefore update tracked version metadata. To bump the base version, update the matching manifests and lockfiles together; `npm.cmd run check` verifies consistency.

Raw executables are `src-tauri/target/<target-triple>/release/yaoc.exe`. Packaging writes `release/yaoc-x64.exe`, `release/yaoc-arm64.exe`, and `SHA256SUMS.txt`, with three rolling `.0.exe`/`.1.exe`/`.2.exe` backups in `release/archive/`. A still-running oldest image is moved to `release/archive/.in-use` until a later packaging run can remove it. `package:installers` also writes `yaoc-setup.exe`, containing both native architectures and selecting ARM64 or x64 automatically; it captures the patched/signed NSIS payload so the portable executable matches byte-for-byte. See [UPDATES.md](UPDATES.md) for signing configuration and native acceptance commands. Portable downloads are `yaoc-x64-portable.zip` and `yaoc-arm64-portable.zip`, each containing the matching executable, `LICENSE`, and `THIRD_PARTY_LICENSES.txt` at the archive root. Packaging creates these ZIPs automatically and includes their hashes alongside the loose executable hashes in `SHA256SUMS.txt`. Publish the ZIPs as the portable downloads; keep the loose executables and rolling backups locally. The checked-in source tree excludes binaries and local build output.

The root `.cargo/config.toml` supplies both LLVM-MinGW linkers and `-C target-feature=+crt-static`. This avoids a separate `libunwind.dll`. The patched `webview2-com-sys` crate embeds the architecture-specific WebView2 loader. Windows system DLLs and the installed WebView2 Runtime remain runtime dependencies. Do not remove the patch or change `dragDropEnabled: false` without testing attachment drag-and-drop.

## Pre-release validation

Start with `npm.cmd ci` so installed frontend tools match the lockfile. Run the checks above, `npm.cmd audit`, and `cargo audit --file src-tauri/Cargo.lock`; inspect informational advisories against the actual Windows dependency graph. Regenerate notices with `npm.cmd run notices`; a missing license text fails generation and must be resolved before packaging.

Keep test builds in Beta until native validation is complete. On Windows 11 ARM64, launch `release/yaoc-arm64.exe` from a clean directory alongside the distribution notices and confirm its About version matches the build being tested. Check the integrated header, dragging/resizing, maximize/restore, minimize, close-to-tray, global shortcut, and restart geometry in both themes.

Use a dedicated test session and disposable workspace file for real-Gateway testing: pairing/reconnect, streaming and stop, attachments, approvals, model/reasoning changes, and workspace save/load. Also switch sessions while Reset is pending, and switch files or reconnect while Save is pending; completion must not replace another transcript, saved baseline, or Gateway's data. Native ARM64 and real-Gateway checks require manual validation when the build machine cannot provide them.

After validation, explicitly build the official version, regenerate notices, package both architectures, verify `SHA256SUMS.txt`, and publish the intended commits and artifacts. Official packaging requires Tauri updater signing configuration; see UPDATES.md. For Certum Authenticode signing, connect SimplySign Desktop and add -Sign to the local build command; see UPDATES.md. This signs both native payloads and the combined installer before ZIPs, updater signatures, and checksums are finalized. Beta artifacts and official artifacts must not be mixed.

## Maintaining icons

Edit `src/assets/yaoc.svg` and run `npm.cmd run icons`. Sharp is a declared development dependency; generated PNG and ICO assets are checked in under `src-tauri/icons/`. Rebuild the app after changing them. The ICO contains 16, 24, 32, 48, 64, 128, and 256px images.

## Troubleshooting

- **Linker not found:** ensure the LLVM-MinGW `bin` directory is on the current PATH.
- **PowerShell blocks npm.ps1:** use `npm.cmd` as in these examples.
- **Frontend changes missing:** use an npm build command. Calling Cargo alone embeds the existing `dist/` assets.
- **WebView fails to start:** install/repair the Microsoft Edge WebView2 Runtime. Diagnostics are written to `%APPDATA%\yaoc\diagnostics.log`; redact private data before sharing logs.
- **Shortcut already registered:** choose a different shortcut in Settings. Existing saved shortcuts override the default.

## MSIX packages and bundle

Run from the network source checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-local.ps1 -Channel Beta -Msix
```

This builds both Beta architectures and the existing EXE/ZIP installers, then creates local release/msix/yaoc-x64.msix, yaoc-arm64.msix, and yaoc.msixbundle. To package an existing matching build, run npm.cmd run package:msix in the local build workspace. Packaging checks executable product versions, uses MakeAppx's normal validation, includes licenses and tile icons, and writes separate checksums and build metadata. It never signs or publishes packages. Delivery to the network checkout is a separate verified copy.

MakeAppx is provided by Windows SDK. Set YAOC_MAKEAPPX to its executable path, or download Microsoft's SDK build tools locally without a system installation. Run in the local build workspace:

```powershell
$tools = Join-Path $PWD '.local\msix-tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null
Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.26100.9169/microsoft.windows.sdk.buildtools.10.0.26100.9169.nupkg' -OutFile "$tools\sdk.zip"
Expand-Archive -LiteralPath "$tools\sdk.zip" -DestinationPath "$tools\sdk" -Force
npm.cmd run package:msix
```

The default identity is io.github.lzs.yaoc.dev, publisher CN=YAOC Development, and display name **YAOC Beta**. This is an unsigned development package, not a Store submission. Beta MSIX versions use year.MMDD.HHMM.0 with leading zeros removed; the embedded app retains its full Beta version. Repeat package versions do not constitute updates.

For Store submission, reserve the product in Partner Center and supply the exact Product identity fields, plus an explicitly managed four-part version:

```powershell
$env:YAOC_MSIX_NAME = '<Package/Identity/Name>'
$env:YAOC_MSIX_PUBLISHER = '<Package/Identity/Publisher>'
$env:YAOC_MSIX_PUBLISHER_DISPLAY_NAME = '<PublisherDisplayName>'
$env:YAOC_MSIX_VERSION = '2026.1.0.0'
npm.cmd run package:msix
```

Supply all identity values together. Increase the package version for updates; its components must fit 0–65535, the first must be nonzero, and the last must be 0 for Store submissions. Package identity is separate from the Tauri identifier and portable notification identity.

MSIX copies run as full-trust desktop applications on Windows 10 version 2004 or later and require Microsoft Edge WebView2 Runtime. The embedded loader remains present; MSIX does not bootstrap the runtime. Packaged copies use their Windows package notification identity and block the NSIS updater; updates belong to the Store or MSIX distribution source. AppData file writes use standard MSIX virtualization: on first run a packaged copy can read existing settings in %APPDATA%\yaoc and %LOCALAPPDATA%\io.github.lzs.yaoc, but its writes go to the package's private storage. Packaged state is therefore separate from portable and NSIS copies, and Windows removes it on uninstall. The package requests no unvirtualizedResources capability; explain only runFullTrust during Store review.

Unsigned packages cannot be installed directly by double-clicking. The Store signs approved submissions; direct distribution requires a Windows code-signing certificate trusted by the destination computer. Tauri updater keys cannot sign MSIX. For local testing, sign a copy with a development certificate and trust only its public certificate on the test machine. Never distribute a private key. Before publishing, run Windows App Certification Kit and test packaged launch, WebView2, notifications, single-instance behaviour, virtualized data, updates and uninstall cleanup on x64 and ARM64.

References: [MakeAppx packaging](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool), [MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide), [virtualization and persistent data](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization).

For an explicitly requested official build, load the updater signing environment described in UPDATES.md, then invoke the local workflow with -Channel Official -Sign -Msix. The default channel is Canary. Official installer packaging requires the existing Tauri updater key and its password; enter passwords locally and never store them in source or build logs. MSIX signing remains separate from installer updater signing.

Official MSIX builds load the public Partner Center identity from src-tauri/windows/msix-store.json and map the app version to major.minor.patch.0. Environment values can override these defaults when necessary. Beta builds retain the development identity unless explicitly overridden.
