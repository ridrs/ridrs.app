<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0031: Files as the Capability `storage.app-files`

## Context

Recordings and FIT files must be written in Node (headless), in the Tauri WebView and in memory in tests, while the core stays runtime-neutral.

## Decision

- Capability `storage.app-files` (single): `append`, `write`, `read`, `list`, `remove`. Paths are relative and `/`-separated; `..`, `.`, absolute paths, drive letters, backslashes and empty segments are rejected with `invalid-path` (`assertAppFilePath` in contracts, used by every provider).
- Providers: `storage-files-node` (ADR 0037), `storage-files-tauri` (ADR 0038), the test fixture `fixture-storage-memory`. Their manifests carry the type `storage`.
- Build-layer exclusion as for `transport-ble-noble`: `apps/native` does not bundle `storage-files-node`; `apps/headless` disables `storage-files-tauri`. `scripts/check-native-bundle.mjs` checks the native bundle.

## Consequences

- Old e2e scenarios that load every plugin folder in the native composition find two providers (ambiguous, both blocked): those apps record nothing, as before. Scenario hosts store into a temporary `RIDRS_DATA_DIR`, never into the developer's data directory.
