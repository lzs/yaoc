# Portable updates and publishing

YAOC keeps its single-file Windows distribution. Settings → About → **Check for updates** checks official GitHub Releases on demand. There are no background checks or automatic installations. Beta builds can explicitly check for a newer official release; they never fetch another Beta.

The client trusts the Ed25519 identity in `src-tauri/update-public.json` (key ID `19504e87acede4ab`). It verifies signed metadata before offering an update, derives URLs from the fixed `lzs/yaoc` repository and validated version, selects the architecture of the running executable, and bounds downloads by the signed size. SHA-256 is checked after downloading and immediately before replacement. Equal versions and downgrades are rejected. Gateway TLS exceptions do not affect updater HTTPS.

After downloading, **Update and restart** requires confirmation. Restart is blocked while any session has drafts/attachments, responses are active, or a workspace file is unsaved/is saving. Closing Settings leaves a download running; it never installs automatically. Another check discards the previously staged update. Failed downloads discard temporary files.

## Replacement and recovery

`self-replace` is pinned to `1.5.1` behind a small Rust adapter. YAOC creates and flushes a recovery copy beside the original executable before replacement. Windows uses temporary copies to clean up the relocated running image after exit. There is no separately installed updater, service, or installer. The new app waits for its predecessor before opening settings, hotkeys, or the Gateway. The original filename and directory are retained, including renamed executables and paths with spaces/Unicode.

For `yaoc-arm64.exe`, the recovery copy is `.yaoc-arm64.exe.pre-update.exe`, kept until the next update. YAOC restores the original path if a swap fails after moving the old image aside, or if launching the replacement immediately fails. A crash after successful launch requires manual recovery; automatic crash detection/health rollback is not implemented. Power loss can leave helper/staging files behind. Read-only directories or locked backups produce an error; the updater never elevates permissions.

To recover manually: fully quit YAOC, including its tray icon, copy the `.pre-update.exe` backup over the normal executable, and launch the normal executable again. Alternatively download the matching architecture from [GitHub Releases](https://github.com/lzs/yaoc/releases). Older builds without updater support need one manual upgrade to an update-enabled build.

## Local signing and manual publication

YAOC releases are currently signed locally and published manually. No GitHub signing secrets are required. Keep the existing encrypted private key in your Nextcloud-backed directory and its passphrase in your password manager. Do not paste either into chat or source control; reuse the existing signing identity.

After building an official release, generating notices, and packaging both architectures, run from the repository root:

```powershell
npm.cmd run updates:sign -- --key "$env:USERPROFILE\Nextcloud\CloudDocs\Sync\npm-signing\yaoc-singing\yaoc-update-private.pem"
```

For a separately staged release directory, add `--dir "release\2026.1.0"`. Keep that directory's executables unchanged after signing. Commit the release source before creating its Git tag so the release points to the code used for the build.

The command prompts for a hidden passphrase, checks the key against the embedded identity and checks PE architecture headers. It signs the official version in `package.json` and rejects Beta version strings. Automation can use `--key-env VARIABLE_NAME` for the encrypted PEM and `--password-env VARIABLE_NAME` for its passphrase. Pass only variable names on the command line.

A release tagged exactly `v<version>` must include:

```text
yaoc-x64.exe
yaoc-arm64.exe
latest.json
SHA256SUMS.txt
LICENSE
THIRD_PARTY_LICENSES.txt
```

On GitHub, create a draft release for the committed source tagged exactly `v<version>`, upload the six files above, and review it before publishing as a non-prerelease marked latest. Keep published assets immutable; correct mistakes with a new version. The optional GitHub Actions draft-release workflow is retained for future automation and is not needed for local signing or manual publication. Update signatures are separate from Authenticode; the executables are not Authenticode-signed.

Asset names stay fixed; version-specific URLs distinguish builds. The client reads `https://github.com/lzs/yaoc/releases/latest/download/latest.json`. Never upload Beta executables under an official manifest. A signature proves identity/integrity, not that a binary was built from the intended source; the publishing process must ensure both.

## Verify a release yourself

From the repository root, run:

```powershell
npm.cmd run updates:verify -- --dir "release\2026.1.0"
```

This read-only command verifies `latest.json` against the embedded public identity, verifies both executables' sizes and SHA-256 hashes against the signed payload, checks `SHA256SUMS.txt` agrees, and checks both licence files are present. It requires no private key or passphrase, prints PASS on success, and exits nonzero with an error on failure. The licence files are checked for presence, not authenticated by the signed manifest. ZIP files are not covered by this check.

To check files downloaded from GitHub, put the six release assets in a separate directory and supply that directory with `--dir`. Use a trusted checkout of YAOC for the verifier and its public key; downloading an untrusted replacement public key alongside the files would not establish authenticity. Verification does not launch the app or establish that it is free of bugs or malware.

## Protocol and maintenance

`latest.json` contains `keyId`, `payload` (base64 UTF-8 JSON), and `signature` (base64 Ed25519 signature). Sign `YAOC-UPDATE-V1\n` followed by the decoded payload, with an actual LF after V1. The payload has `formatVersion: 1`, `version`, `channel: "official"`, and exactly two assets with `name`, `size`, and lowercase hexadecimal `sha256`. Verification uses the exact signed bytes, without reserializing JSON. Neither manifests nor renderer commands can supply arbitrary executable paths, URLs, or shell commands.

Version checks prevent downgrades but cannot detect a server withholding a newer release. There is no remote key rotation yet: a transition release signed by the existing key must embed support for the new identity before changing signing keys. Keep the existing key until that transition reaches users.

Run dependency audits and native x64/ARM64 update tests before official releases. The swap adapter can be replaced without changing GitHub assets, signature protocol, or installed paths. Automated tests cover signing, tampering, version/architecture/size restrictions, staged-file changes, swap-failure recovery, isolated Windows replacement of a renamed executable, and browser update/error/cancel states. ARM64 compilation does not replace native ARM64 testing.

Before first publication, test renamed paths with spaces/Unicode, both native architectures, drafts in other sessions, unsaved files, network failure, locked/unwritable destinations, and manual recovery. A complete live GitHub upgrade requires two published versions or a controlled test feed; building these executables alone does not exercise it.

## Key generation for a different distribution

`npm.cmd run updates:keygen -- --out <absolute-directory-outside-repository>` generates encrypted Ed25519 PKCS8 PEM and public JSON with a hidden, confirmed passphrase. It refuses existing identities and repository destinations. This command is retained for development/recovery and is not needed again for YAOC's existing identity.
