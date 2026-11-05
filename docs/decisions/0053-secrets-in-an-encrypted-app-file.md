<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0053: Secrets in an Encrypted App File

Status: accepted on 2026-11-05 (the maintainer: no Keychain, no prompt at startup) and implemented the same day. Replaces [ADR 0050](0050-secrets-in-the-os-keychain.md) on macOS and the desktop; Android keeps its store.

## Context

[ADR 0050](0050-secrets-in-the-os-keychain.md) put the intervals.icu token in the legacy macOS Keychain. The Keychain ties an item to the signature of the app that created it; every development build is signed anew, so macOS asked for the login password on the first read after each build, at startup. The maintainer wants a store that never asks. The companion pairing (its token included) still sat in the WebView's `localStorage`.

What has to hold: no interaction, ever; not readable by other users of the machine; not readable from the WebView through the fs plugin; useless when copied to another machine (a backup, a shared folder). What cannot hold without the Keychain: protection from other programs of the same user. They can read the app's files and derive the same key. That is accepted.

## Decision

- **One file, `secrets.bin`, in the app data directory** (`$APPDATA`, outside every fs-plugin scope: `recordings/`, `training/`, `config/`). Mode `0600` on Unix. Written to a temporary file, flushed, renamed over the old one, the directory flushed.
- **AES-256-GCM** (`aes-gcm` 0.10.3, RustCrypto, Apache-2.0 OR MIT) over the JSON object key → value. Layout: magic `RIDRSEC1`, a 16-byte random salt, a 12-byte random nonce (new on every write), ciphertext and tag; magic and salt are the associated data.
- **The key is derived from the machine**: HKDF-SHA256 (`hkdf` 0.12.4, `sha2` 0.10, MIT OR Apache-2.0) over the machine id (`machine-uid` 0.6.0, MIT: `gethostuuid` on macOS, `/etc/machine-id` on Linux, `MachineGuid` on Windows), the file's salt and the info `org.ridrs.app/storage.secrets/v1`. Nothing secret is stored next to the file.
- **Android keeps `android-native-keyring-store`** (ADR 0050): `SharedPreferences` encrypted with a key in the Android Keystore. It never asks either, and the Keystore key is not part of Android's auto-backup. iOS keeps its store (not a target).
- **The Rust code moves to `crates/ridrs-secrets`** (AGPL-3.0-or-later), so the native app and the companion share it. The commands stay `secret_get`, `secret_set`, `secret_remove`.
- **A file that cannot be decrypted** (another machine's, a changed machine id, damage) makes `get` fail with `secrets unreadable`; `set` replaces it with a new file. The planner reports the rider as not connected, as before.
- **No migration from the Keychain**: reading the old item would show the prompt once more. The rider signs in to intervals.icu again once; the old item stays in the Keychain until removed by hand ("org.ridrs.app" in Keychain Access).
- **The companion pairing moves to `storage.secrets`** under `bridge.pairing` (the whole pairing: its token is the secret, the rest is useless without it). `bridge-connector-tauri` requires `storage.secrets`, loads the pairing when it initializes and moves a pairing it finds in `localStorage` once. The companion keeps its id and the tokens it issued in the same store (`companion.state`).

## Consequences

- No prompt at any start, on any build.
- Weaker than the Keychain against programs of the same user; stronger than `localStorage` and plain files against other users, backups and the WebView.
- Replacing the Mac's logic board changes its id: secrets are then unreadable and the rider signs in and pairs again.
- `keyring-core` and `apple-native-keyring-store` are no longer used on macOS.
