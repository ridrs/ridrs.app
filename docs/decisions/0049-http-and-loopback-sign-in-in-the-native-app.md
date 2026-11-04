<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0049: HTTP and Loopback Sign-in in the Native App

Status: accepted on 2026-11-04 and implemented the same day, for [ADR 0048](0048-intervals-icu-connection-and-training-plan.md).

## Context

`planner-intervals-icu` needs `net.http` and `auth.browser-sign-in`. The host runs in the webview. A `fetch` from the webview to `https://intervals.icu` depends on the service's CORS headers and would open the CSP (`connect-src ipc: http://ipc.localhost` today). The sign-in must open the system browser (never a webview: the rider types the password into intervals.icu, not into ridrs) and receive the redirect on `127.0.0.1`.

## Decision

- **`net-http-tauri`** provides `net.http` with the official **`tauri-plugin-http`** 2.8.3 (Rust crate and `@tauri-apps/plugin-http`, MIT OR Apache-2.0). Requests run in Rust: no CORS, no CSP change. The capability allows only `https://intervals.icu/api/*`, which includes the token endpoint `/api/oauth/token`.
- **`auth-sign-in-tauri`** provides `auth.browser-sign-in` with:
  - **`tauri-plugin-oauth`** 2.1.0 (FabianLars, crate and `@fabianlars/tauri-plugin-oauth`, MIT OR Apache-2.0): a one-shot HTTP server on `127.0.0.1` and a free port that hands the redirect URL to the webview and answers the browser with a short page ("You can return to ridrs"). The plugin starts it, builds the authorization URL with the port, and stops the server after the first callback or when cancelled.
  - The official **`tauri-plugin-opener`** 2.7.2 (MIT OR Apache-2.0) to open the authorization URL in the system browser, allowed only for `https://intervals.icu/oauth/authorize*`.
  - Timeout: 5 minutes without a callback cancels the sign-in (`sign-in-cancelled`); intervals.icu wants the code exchanged within 2 minutes of the redirect, which the planner does at once.
- **Node** (headless and tests): no provider today. The headless app has no use case for intervals.icu; the scenarios use simulated providers.

## Consequences

- Three new Rust plugins in `apps/native/src-tauri`. They are registered in `lib.rs` and allowed in `capabilities/default.json`, scoped as above.
- The redirect on Android is unproven: `tauri-plugin-oauth` is plain Rust networking, but Android may suspend the app while the browser is in front. This is the first thing the vertical use case checks on the phone.
- Permissions in `capabilities/default.json`: `http:default` scoped to `https://intervals.icu/api/*`, `opener:allow-open-url` scoped to `https://intervals.icu/oauth/authorize*`, `oauth:allow-start` and `oauth:allow-cancel`.
- `tauri-plugin-oauth` answers any request on its port and hands its URL to the webview; the planner accepts only an answer with its own `state`.
- `tauri-plugin-http` brings `rustls` with `webpki-roots` (Mozilla's root certificates, CDLA-Permissive-2.0, a permissive data licence; listed in NOTICE).
- Checked with `cargo check` for macOS and `aarch64-linux-android`; not yet run on a device.
