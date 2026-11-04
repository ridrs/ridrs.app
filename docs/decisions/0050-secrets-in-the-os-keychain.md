<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0050: Secrets in the OS Keychain

Status: accepted on 2026-11-04 and implemented the same day, for [ADR 0048](0048-intervals-icu-connection-and-training-plan.md). Keychain over a file: chosen by the maintainer on 2026-11-04.

## Context

The intervals.icu token works like a password for the athlete's calendar and settings. App files (`storage.app-files`) are plain files in the app container. `storage.secrets` should keep the token in the operating system's credential store on macOS and Android, without asking the rider for anything.

Options looked at:

- `tauri-plugin-stronghold` (official): an encrypted file that needs a password from somewhere. That only moves the problem.
- `tauri-plugin-keystore` (mobile only, alpha) and `tauri-plugin-biometry`: they ask for biometrics on every access. Not wanted at app start.
- `tauri-plugin-keyring`, `tauri-plugin-keychain`, `tauri-plugin-secure-storage`: small, little maintained, or no Android.
- **keyring-core** with its native stores (open-source cooperative, the successor of the `keyring` crate): maintained, MIT OR Apache-2.0, a store per platform.

## Decision

- **`keyring-core` 1.0.1** with **`apple-native-keyring-store` 1.0.2** (macOS: the legacy Keychain, feature `keychain`, since the "protected data" store needs a provisioning profile; iOS: feature `protected`) and **`android-native-keyring-store` 1.0.0** (Android `SharedPreferences`, encrypted with a key in the Android Keystore). All MIT OR Apache-2.0. The store is chosen per target in `Cargo.toml`. The Android store needs the `ndk-context`, which Tauri's mobile runtime initialises.
- Three app-local Tauri commands in `apps/native/src-tauri` (`secret_get`, `secret_set`, `secret_remove`), service `org.ridrs.app`, the key as user name. They are thin glue over the library, like the existing `ble_*` commands.
- **`storage-secrets-tauri`** (AGPL-3.0-or-later) provides `storage.secrets` through these commands.
- Keys are dotted ids (`intervals-icu.token`); values are UTF-8 text.

## Consequences

- Deleting the app deletes the token on Android; on macOS the Keychain entry stays until "Disconnect" or manual removal.
- A missing or locked store makes `get` fail. The planner then treats the rider as not connected and reports why.
- The store is set up on the first `secret_*` call, when Android's app context exists. Platforms without a store (Windows, Linux) answer every call with an error.
- Checked with `cargo check` for macOS and Android; not yet run on a device.
