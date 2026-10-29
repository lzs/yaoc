# Distribution and updates

YAOC ships per-user NSIS installers and standalone single-file executables for Windows x64 and ARM64. Both contain the same application executable for a given architecture/version. "Portable" means no installer is required; settings stay on the Windows account.

Both modes share %APPDATA%\yaoc and the existing WebView2 profile at %LOCALAPPDATA%\ai.openclaw.chat.lite. DPAPI-protected credentials remain account-bound. A user-profile file lock is acquired before mode detection, credentials, WebView2, notification integration or hotkeys. Another launch signals the primary to show its window and exits. Only one instance can use the shared profile, including across logon sessions (Windows cannot focus another session's desktop).

The installer creates install-metadata.json next to yaoc.exe, containing formatVersion 1 and the absolute installDirectory. Metadata may be UTF-8 or NSIS UTF-16LE. Missing metadata means portable; malformed, inaccessible or location-mismatched metadata produces a startup error. Copy a standalone executable into a separate directory to use portable mode. About shows the active mode and executable/data paths.

## Updates

Both modes check official releases using https://github.com/lzs/yaoc/releases/latest/download/installer-update.json. Versions must be stable SemVer newer than the running version; Beta builds also check official releases only. Discovery uses HTTPS; installer bytes require Tauri signature verification, independently of Authenticode. Discovery information alone never authorizes code execution.

Installed mode uses tauri-plugin-updater, pinned in Cargo, to download/verify the architecture-specific NSIS installer. The download URL must belong to the exact versioned lzs/yaoc release. Installation verifies the bytes again and passes the running installation directory to NSIS. Existing drafts, attachments, active responses and unsaved/saving files block the confirmed install/restart action. Tauri saves window state before exiting, and NSIS waits for the exact installed executable to become writable before modifying it. No process-name-wide termination is used. Installation errors are reported; there is no automatic startup-crash rollback. Re-run a trusted installer if recovery is needed.

Portable mode only reports the newer version and opens the official release page. Quit YAOC including the tray icon, download the matching x64/ARM64 executable and replace the old file. Shared settings remain intact. Backend commands reject download and install in portable mode. There is no portable self-replacement implementation, custom signed manifest or predecessor-wait protocol.

## Windows integration and uninstall

NSIS owns YAOC's standard shortcut, shortcut AUMID and installed notification registration. The application selects its process AUMID but never creates shortcuts or rewrites installed registration. Portable mode uses ai.openclaw.chat.lite.portable and an in-app notification banner with taskbar attention and optional sound. It does not register a portable toast identity in HKCU or create portable shortcuts. Hidden portable windows do not display native toast banners; open YAOC from the taskbar/tray to see the notification. Installed mode uses native Windows toasts.

The vendored NSIS template comes from tauri-cli-v2.10.1 under MIT/Apache-2.0. YAOC removes its data-deletion checkbox and deletion code completely; no data-deletion command-line switch exists. Ordinary and silent uninstalls and upgrades preserve both shared data directories. Uninstall deletes only installer-owned application files, metadata and integration. It uses the actual installation directory and leaves unrelated files and portable copies intact. Windows DPAPI master keys are never touched. Upgrade does not remove installed notification identity.

## Build and publish

Normal builds remain Beta:

```powershell
npm.cmd run dist:all
npm.cmd run notices
npm.cmd run package:installers
```

The packaging command bundles existing executables for both targets and then invokes package:portable, preserving three rolling backup generations in release/archive/. If Windows still holds the oldest image open, it is moved to release/archive/.in-use so the active session can continue; a later packaging run removes it after it exits. Outputs are release/yaoc-x64.exe, yaoc-arm64.exe, yaoc-x64-setup.exe and yaoc-arm64-setup.exe, plus notices and portable SHA256SUMS.txt. Embedded WebView2Loader.dll is retained; portable copies still require the WebView2 runtime. NSIS can bootstrap the runtime.

Beta packaging can be unsigned for local testing. It does not publish official update metadata. If no updater public key was compiled into a Beta, installed update checks explain that installation is unconfigured and direct the user to manual downloads.

Official builds must be requested explicitly. The former npm run updates:keygen command created a PKCS8 identity for the removed custom portable updater. It is not the Tauri signing format. Generate a separate Tauri key pair once, keeping the existing signing directory and leaving the old files untouched. The owner's directory is spelled yaoc-singing as shown below.

Run locally (not through chat), and choose a password when prompted:

```powershell
Set-Location "$env:USERPROFILE\Nextcloud\CloudDocs\AppProjects\yaoc"
$yaocSigningDir = "$env:USERPROFILE\Nextcloud\CloudDocs\Sync\npm-signing\yaoc-singing"
npm.cmd exec -- tauri signer generate -w "$yaocSigningDir\yaoc-tauri-updater.key"
```

Do not use --force or overwrite an existing key. Keep the resulting yaoc-tauri-updater.key and its password securely backed up; yaoc-tauri-updater.key.pub is the shareable public key. Reuse this new Tauri identity for subsequent releases. Do not commit private signing material.

Before each official build, configure the same PowerShell session:

```powershell
$yaocSigningDir = "$env:USERPROFILE\Nextcloud\CloudDocs\Sync\npm-signing\yaoc-singing"
$env:YAOC_UPDATER_PUBLIC_KEY = (Get-Content -Raw "$yaocSigningDir\yaoc-tauri-updater.key.pub").Trim()
$env:TAURI_SIGNING_PRIVATE_KEY = "$yaocSigningDir\yaoc-tauri-updater.key"
$yaocKeyPassword = Read-Host "Tauri updater key password" -AsSecureString
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $yaocKeyPassword).Password
```

The password is supplied to the signing tool through this process's environment; the hidden prompt avoids putting it in command history. Do not print or share the password/private key. With the environment configured, the explicitly requested official build sequence is:

```powershell
npm.cmd run release:package
```

The release:package command checks the signing environment, adds the Cargo and LLVM-MinGW tools to its child PATH, and runs check, release, notices and package:installers in order. It stops on the first failure, builds both architectures, and uses the current base version (2026.1.0 at present). It does not tag or publish anything. Keep the signing variables loaded until it finishes.

After signing, clear the password from the shell environment:

```powershell
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Remove-Variable yaocKeyPassword
```

YAOC does not use Windows Authenticode signing. The owner has chosen not to obtain a certificate or signing service. Application executables and installers have no Windows publisher signature; Windows may display an unknown publisher or SmartScreen warning. This does not prevent distribution or Tauri updater signature verification. Official packaging requires only the Tauri updater public/private key configuration, not a certificate.

The custom NSIS template captures the exact bundle-type-patched application payload before Tauri restores its input. Packaging promotes that payload to the target executable and portable outputs, then hashes it. A verified pristine backup allows repeat packaging. Tauri generates detached updater signatures for the completed installers.

package:installers generates installer-update.json for official builds from the two installer .sig files. Publish both executables, both installers, both .sig files, installer-update.json, SHA256SUMS.txt, LICENSE and THIRD_PARTY_LICENSES.txt together as an immutable non-prerelease GitHub release tagged v<version>. Never publish Beta artifacts as official updates. No Tauri private signing identity is supplied by this repository.

## Native acceptance checks

Validate on x64 and ARM64 Windows: install, update, confirmed restart, missing runtime, notifications, hotkeys and second-launch focusing. Check absent/corrupt/stale/copied metadata; switch between installed and portable launches and confirm profiles and localStorage are shared. Test a Unicode/spaced installation path. Verify uninstall (interactive and silent) and upgrades retain sentinel files in both data directories and unrelated files in the installation directory. After uninstall, portable YAOC must still open the same profile. Verify portable checks show only manual-download actions and backend install/download calls fail. Test locked installed files and failed installer downloads/signatures without changing portable copies. Native GUI and signed-release testing requires an interactive Windows host and signing credentials.
