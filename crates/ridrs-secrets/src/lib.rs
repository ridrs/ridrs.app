// SPDX-License-Identifier: AGPL-3.0-or-later

//! `storage.secrets` for the ridrs apps (ADR 0053): secrets are kept without ever asking the
//! rider for anything. On the desktop an encrypted file in the app data directory whose key is
//! derived from the machine; on Android the Keystore-backed store of keyring-core (ADR 0050).
//! Thin glue: the JS side (`plugins/storage-secrets-tauri`) checks the keys.

pub mod commands;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub mod file_store;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod keyring_store;
