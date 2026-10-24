# Contributing

YAOC is an independent OpenClaw Gateway client. Discuss significant behavior changes in an issue before starting a large refactor. Include the Windows architecture, app build version, and Gateway version when reporting a bug, and redact credentials and personal data.

## Development workflow

Follow `docs/BUILD.md` to install the toolchain. Run `npm run check`, `npm test`, `npm run format:check`, the browser smoke tests, Rust tests, and Clippy before submitting a pull request. Use `npm run format` and `cargo fmt --manifest-path src-tauri/Cargo.toml` for formatting. CI compiles both Windows architectures.

Keep changes focused and explain the problem, the resulting behavior, and how you tested it. Add regression tests for state, protocol, persistence, and security changes. UI-only adjustments usually need a visual check in both themes rather than tests that repeat CSS declarations.

## Implementation conventions

- Do not block the UI thread with network requests or long-running native operations.
- Scope drafts, streams, requests, and delayed callbacks to their Gateway and session.
- Handle persistence failures explicitly. Do not silently replace a damaged identity or overwrite settings after a failed load.
- Preserve the existing profile directory, device identity, and WebView2 identifier when changing branding.
- Keep the vendored WebView2 loader notices and document changes to the patch. Regenerate native icon assets from the checked-in SVG.
- Keep the npm, Cargo, and Tauri versions consistent. Use Beta builds for development and retain lowercase portable filenames.
- Do not commit build output, credentials, screenshots containing private conversations, or local agent instructions.

By submitting a contribution, you agree that your contribution will be licensed under the project's [MIT License](LICENSE). Third-party code keeps its original terms; see `THIRD_PARTY_LICENSES.txt` and the vendor notices.
