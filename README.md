<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ridrs

Open-source, modular, headless-first indoor cycling platform.

## Repository Structure

- `apps/native/`: Native app (Tauri 2) for macOS, Android, iOS and Windows: core, plugins and GUI in one WebView process (`@ridrs/native`).
- `apps/headless/`: Headless CLI composition root (`@ridrs/headless`).
- `packages/contracts/`: Public plugin, manifest, event, and capability contracts (`@ridrs/contracts`, `Apache-2.0`).
- `packages/core/`: Runtime-neutral application core: discovery ports, capability resolution, lifecycle, diagnostics, UI registry and typed event bus (`@ridrs/core`, `AGPL-3.0-or-later`; Node-only adapters in `@ridrs/core/node`).
- `packages/ui-sdk/`: Client contract for UI plugins (`@ridrs/ui-sdk`, `Apache-2.0`); `packages/ui-shell/`: the shell that composes screens and slots; `packages/ui-bridge/`: in-process bridge between shell and host.
- `plugins/`: Production plugins (BLE transports for Node and Tauri, FTMS trainer, power/cadence metrics, console output, activity session, UI screens, HUD and widgets).
- `packages/testing/`: In-process BLE simulator and simulated Tauri bridge for tests (`@ridrs/testing`).
- `tests/`: Executable Gherkin specifications (`tests/features/`), step definitions, test harness, and fixture plugins.
- `docs/`: Architecture documentation (`docs/architecture/`) and Architecture Decision Records (`docs/decisions/`).
- `web/`: Cloudflare Worker application serving the project web page ([ridrs.app](https://ridrs.app)).

## Running ridrs headless

Install dependencies and verify the workspace:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Start the headless composition root against the example ping-pong plugins:

```bash
pnpm --filter @ridrs/headless start -- --plugins tests/fixtures/plugins/ping-pong
```

Press `Ctrl+C` (`SIGINT`) to gracefully stop and dispose all plugins.

### Live power and cadence

With hardware (a powered-on FTMS trainer nearby; on macOS the terminal app needs Bluetooth permission):

```bash
pnpm --filter @ridrs/headless start -- --plugins plugins
```

The console shows `searching`, `connecting`, `connected`, then live power and cadence. Switching the trainer off shows `reconnecting` and unavailable values; `Ctrl+C` disconnects and exits with code 0.

Without hardware (simulated trainer `SIM KICKR`):

```bash
pnpm --filter @ridrs/headless start -- --plugins plugins --plugins tests/fixtures/plugins/simulated-trainer --disable transport-ble-noble
```

## The native app: start a ride and see power and cadence

`apps/native` composes all plugins (bundled at build time), the in-process UI bridge and the shell in the Tauri WebView. Prerequisites: Rust (`rustup`), and for Android the Android SDK + NDK (`ANDROID_HOME`, `NDK_HOME`, `JAVA_HOME`) and the Rust target `aarch64-linux-android`; for iOS Xcode, `xcodegen` and CocoaPods. The pipeline below (`pnpm test` etc.) needs none of them.

```bash
pnpm --filter @ridrs/native tauri dev
```

```bash
pnpm --filter @ridrs/native tauri android dev
```

Manual check with a real FTMS trainer: press **Start ride**, pedal: power and cadence appear in the lower corners over the landscape. Switch the trainer off: both show `–` with "disconnected"; switch it on: values return. Press **Finish ride**: back to the main screen. The screen stays on while a ride runs. On Android the app asks for "Nearby devices" first. On macOS the app needs Bluetooth permission on first use.

Without hardware the same composition runs in the tests with the simulated trainer (`tests/features/apps/ride-in-native-app.feature`). The frontend alone also runs in a browser (`pnpm --filter @ridrs/native build`, then `pnpm --filter @ridrs/native exec vite preview`): without Tauri there is no BLE, so the widgets show dashes.

## Tests

- `pnpm test` runs Vitest and Cucumber. Cucumber runs twice: Node-only scenarios, then the `@ui` scenarios (profile `ui`), which render the real shell and UI plugins into a headless DOM (happy-dom). No browser and no Rust toolchain are needed.
- `cargo test` in `apps/native/src-tauri` runs the Rust unit tests of the native BLE layer.

## Web Application

For instructions on local development and deployment of the web application, see the [web README](web/README.md).
