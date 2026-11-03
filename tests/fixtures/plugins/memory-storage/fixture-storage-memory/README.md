<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# fixture-storage-memory

Test fixture that provides `storage.app-files` in memory, for the Phase 9 recording, export and
replay features.

- **The files** live in `globalThis[Symbol.for('ridrs.fixture.memory-storage')]`, a
  `MemoryAppFiles` from `@ridrs/testing`. The World creates it before the host starts and reads
  it in steps; it outlives the plugin, so "the host restarts" finds the files of the last run.
- **Failures:** set `failWrites` on it and every `append` and `write` rejects.
- It also provides `config.snapshot` (section `fixture-storage-memory`), so `recording-session`,
  which requires at least one snapshot provider, runs in features without physics plugins.
