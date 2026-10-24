# Supplemental upstream license texts

These texts fill omissions in dependency source archives; they do not change the license of YAOC.

- `alloc-stdlib-LICENSE.txt`: `dropbox/rust-alloc-no-stdlib`, commit `0a81fd6928ea3b33c8cd484aa4575d50ffb98012`, repository `LICENSE`.
- `webview2-com-macros-LICENSE.txt`: `wravery/webview2-rs`, commit `dffa41a8a46d3f5565eefbff2de57d38d399f158`, repository `LICENSE`.
- `selectors-LICENSE.txt`: Mozilla Public License 2.0, canonical text from https://www.mozilla.org/MPL/2.0/. The unmodified covered source is available at https://github.com/servo/stylo/tree/572ecba2d1600e7c3d490586692a209faf703baa/selectors (selectors 0.38.0).

The `webview2-com` 0.39.1 license is identical to the retained vendor license at its recorded upstream commit. Native esbuild and Rollup packages use their parent npm package's included license. The notices generator uses these explicit fallbacks and reports any unresolved missing terms.
