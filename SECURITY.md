# Security

YAOC is a Windows client for a Gateway chosen by the user. Treat that Gateway and its connected agents as trusted with messages, attachments, and workspace contents.

## Reporting a vulnerability

Do not post tokens, passwords, private keys, personal conversations, or a working exploit in a public issue. Use the repository's private vulnerability-reporting feature if the maintainer has enabled it. If it is unavailable, request a private contact channel without disclosing the exploit publicly.

## Current security properties and limits

- Remote connections should use HTTPS/WSS. Plain HTTP/WS provides no transport encryption and is appropriate only for trusted local connections/tunnels.
- The explicit certificate-bypass setting disables TLS certificate and hostname verification. Leave it off for normal use.
- Saved profiles contain authentication tokens/passwords, and the device identity contains an Ed25519 private key. On Windows, YAOC encrypts these secrets at rest using Windows DPAPI (`CryptProtectData` bound to the current Windows user account). A process running under the same Windows user session can still decrypt them via DPAPI, so disk encryption and Windows account protections remain important.
- Workspace edits and tool approvals are executed by the Gateway. Access restrictions must be enforced there; the client is not a sandbox for agent activity.
- Markdown renders text through React rather than injecting raw HTML. A production content-security policy restricts script execution and frontend network connections, and image previews only render local `data:image/...;base64,...` or `blob:` attachments rather than fetching remote HTTP(S) URLs.
- The patched WebView2 loader writes fresh embedded DLL bytes into a private per-process directory, retains a read lock that denies replacement for the lifetime of the process, prunes stale directories from exited processes, and restricts dependent DLL lookup to that directory and System32. It does not trust the old shared temporary cache.
- There is no automatic updater or code-signing setup in this repository. Verify release checksums against a trusted source; a checksum alone does not authenticate the publisher.

## Before publishing a release

Run the checks in `docs/BUILD.md`, `npm audit`, and `cargo audit --file src-tauri/Cargo.lock`. Review informational and platform-specific advisories as well as vulnerability errors. Retain dependency license notices in the release archive. Never publish `%APPDATA%\openclaw-chat`, local coding-agent files, or development logs.
