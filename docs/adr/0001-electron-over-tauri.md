# Electron instead of Tauri for the desktop Host

macOS and Linux are both primary targets. Tauri renders with WebKitGTK on
Linux, which is its slowest and least consistent webview, and our heaviest UI
workloads (Monaco, xterm.js, large virtualized tables) are the ones most
exposed to that. Electron ships one Chromium on every platform, so we test
against a single engine and get Chromium's devtools. We accept the larger
install size and memory use.

## Considered Options

- **Tauri**: small binaries and a native Rust core, but three different
  webviews and weak Linux rendering. Worth revisiting if Tauri's Chromium
  runtime matures.
- **Electron with a Rust napi-rs addon**: no local socket to secure, but it
  ties the UI to Electron and rules out a browser Host. See ADR-0002.
