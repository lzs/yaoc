# YAOC local patch

Upstream: https://github.com/wravery/webview2-rs, crate `webview2-com-sys` 0.39.1, commit `edc2caf886175ccaebe86078c9cfe1ae2a187328` (crate provenance is retained in `.cargo_vcs_info.json`). Upstream Rust bindings are MIT-licensed; see `LICENSE`.

This patch replaces upstream static/MSVC loader linking with architecture-specific embedded DLLs and forwarding exports, for LLVM-MinGW x64/ARM64 portable builds. `build.rs` links `advapi32`; `src/lib.rs` contains the embedded loader and a WebView2 busy-profile fallback. Generated `bindings.rs` and `declared_interfaces.rs` are retained from upstream.

The embedded DLLs match Microsoft.Web.WebView2 SDK **1.0.3800.47** from NuGet byte for byte:

| Architecture | WebView2Loader.dll SHA-256 |
| --- | --- |
| x64 | 86545b66cdb0603bc26b626fb9ad610cb6e71f28d468f5ea66df23b03dda96d5 |
| ARM64 | a0de1844933a10c898f833771a85f0ab9a0e3c745d4715f63d2d9730f9416025 |
| x86 | 161dc6673084a31f64670ace8e61cb0e1b55af815b6c7c8217a0cdd8503454e2 |

Microsoft's SDK `LICENSE.txt` and `NOTICE.txt` are included as `MICROSOFT-WEBVIEW2-LICENSE.txt` and `MICROSOFT-WEBVIEW2-NOTICE.txt`. Unused `WebView2LoaderStatic.lib` archives are omitted; the DLLs remain required source assets. Preserve these notices when redistributing.

The loader creates a private per-process directory, writes fresh embedded bytes with checked errors, opens a read lock that denies writes/deletion, compares the full bytes, and loads with `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`. Old shared temporary-cache DLLs are never reused. This reduces cache replacement and dependency-search risks; processes running as the same Windows user remain outside YAOC's security boundary.
