<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0054: Plugin Settings Documents; the Remembered Device per Kind

Status: accepted on 2026-11-05 (JSON documents first, chosen by the maintainer) and implemented the same day, for [ADR 0052](0052-persistence-domains-and-plan.md). Amends [ADR 0046](0046-one-link-per-device-and-signal-strength.md): device choices outlast the run.

## Context

The device choices last one run ([ADR 0042](0042-device-links-in-the-peripheral-link.md), [ADR 0046](0046-one-link-per-device-and-signal-strength.md)): after every start the first device found connects, in a studio maybe not the rider's. Plugins have no way to keep configuration; giving them `storage.app-files` would let any plugin write anything anywhere in the data directory.

## Decision

- **Manifest field `persistence`**, today only `["machine"]`. It grants `ctx.settings.machine(document)`; without it the call throws `permission-denied`. Only plugins with a driver type may declare it (`transport`, `storage`, `ui`, `device`): a plugin of simulation types only (physics, metrics, activity, …) declaring it is an `invalid-manifest`. Simulation values must enter as inputs instead ([ADR 0052](0052-persistence-domains-and-plan.md)).
- **A settings document** is `{ name, version, schema, migrate? }` (a zod schema). `read()` gives the value or `undefined` (absent, unreadable, a newer version, or failing the schema: then a `settings-invalid` diagnostic, never an exception at start). An older version goes through `migrate(fromVersion, value)`. `write(value)` validates and replaces the document atomically; it is committed once the promise resolves. Writes of one document run one after another.
- **Files**: `config/machine/<plugin id>/<name>.json` holding `{ "version": n, "value": … }`, through the `AppFiles` the composition root gives the host (`PluginHostOptions.settingsFiles`). No database yet: SQLite comes with the athlete profile behind the same access. A host without settings files (a replay) reads nothing and writes nowhere.
- **`AppFiles.replace(path, bytes)`**: write a temporary file, flush it, rename it over the old one. Node: `node:fs/promises` (`FileHandle.sync`, `rename`). Tauri: the app command `app_file_replace` in Rust (`File::sync_all`, which is `F_FULLFSYNC` on Apple platforms); `@tauri-apps/plugin-fs` has no flush. The command accepts only paths below `recordings/`, `training/` and `config/`.
- **The remembered device.** The peripheral link keeps one document per link (`device-<kind>`, plus the link's label where a plugin has several links of a kind): the device last connected (its link, its id on the link, its name) or "forgotten".
  - A remembered device is the only one of the kind that connects on its own, as soon as its link sees it. Another device found does not connect, even with the device setup open; the rider can connect it, and then it is remembered.
  - "Forget" is remembered: after a restart no device of the kind connects on its own until a device setup opens, as within a run ([ADR 0046](0046-one-link-per-device-and-signal-strength.md)).
  - Nothing remembered: as before, the best device found connects, and is remembered once connected.
  - Ids are the link's own (CoreBluetooth's UUID on a Mac, the address on Android and through the companion): stable on one machine, which is the domain of machine configuration. A remembered device the link never sees again simply never connects; the rider connects another in the device setup.

## Consequences

- Device plugins (`device-ftms-trainer`, `device-heart-rate`, `device-zwift-ride`) declare `"persistence": ["machine"]`; their `start` reads the document before the link scans.
- The Tauri capability allows the fs plugin to read and list `$APPDATA/config/**`; writes go through `app_file_replace`.
- Replays and recoveries are unaffected: the link's choices only decide which connection inputs arrive, and those are recorded.
- Removing a plugin leaves its folder below `config/machine/`; cleaning up waits for a use case.
