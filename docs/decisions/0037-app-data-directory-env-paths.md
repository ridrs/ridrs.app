<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0037: The App Data Directory with `env-paths`

`storage-files-node` stores below the per-OS app data directory from **env-paths** 4.0.0 (MIT, pure ESM): `envPaths('ridrs', { suffix: '' }).data` (`~/Library/Application Support/ridrs` on macOS, `~/.local/share/ridrs` on Linux, `%LOCALAPPDATA%\ridrs\Data` on Windows). `RIDRS_DATA_DIR` overrides it (tests, e2e). File I/O uses `node:fs/promises`.
