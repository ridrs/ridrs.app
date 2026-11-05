<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Proposal: Persistence, Data Ownership, Providers, Sync and Session Recovery

**Status: accepted with changes on 2026-11-05 ([ADR 0052](../decisions/0052-persistence-domains-and-plan.md)); phases P0–P5 implemented ([ADR 0053](../decisions/0053-secrets-in-an-encrypted-app-file.md)–[ADR 0057](../decisions/0057-continuing-an-interrupted-ride.md)).** The text below is the proposal as reviewed; where the decisions differ, the ADRs hold. The main changes: no OS keychain on macOS (an encrypted app file, ADR 0053), JSON settings documents before SQLite (ADR 0054), no `KnownDevice` list or route preference (ADR 0046 removed the second link per device), ADR numbers 0052–0057 instead of 0046–0051. It reviews the brief "Persistence, Data Ownership, Provider Abstraction, Cloud Synchronization, and Session Recovery" against the code as it is today, challenges parts of it, and proposes an incremental plan. Every step still starts with failing Cucumber scenarios and gets its own ADR (AGENTS.md rules 1–3).

Markers:

- **[Fact]** verified against the code on 2026-11-04.
- **[Proposal]** a recommendation; needs maintainer approval.
- **[Challenge]** where this proposal deliberately deviates from the brief, with the reason.
- **[Open]** a question for the maintainer.

---

## Summary

1. **ridrs already has most of a session journal.** The recording (`recording-session`, `@ridrs/recording`) appends every envelope, inputs flagged `input: true` with logical time, acceptance order and deterministic ids, and the replay host re-executes those inputs into identical state. Recovery should **extend the recording into the journal** and **reuse the replay host** to rebuild state, not add a second event log.
2. **[Challenge] No checkpoints in the first recovery step.** Because the simulation is deterministic, every committed prefix of the journal *is* a consistent state. Recovery = replay the prefix, then continue live. Checkpoints (and the plugin-state serialization contract they require from every plugin) come only if measured recovery time exceeds a budget.
3. **[Challenge] "Persist before the input affects state" is not needed for consistency** and would block the synchronous turn queue on I/O. Determinism makes a lost-but-processed input harmless: recovery yields the state of the committed prefix, as if the lost inputs never arrived. Only effects that leave ridrs and must not be lost or repeated (uploads, trainer commands later) need a commit-before-effect rule (an outbox).
4. **The real missing piece for "continue the ride" is a pause.** Today `activity-session` knows only `idle → running → finished` and `physics-engine` schedules every 10 ms step from `startedAt`. After a restart, the clock would catch up the whole downtime as coasting. Recovery needs an explicit, journaled interruption that pauses the simulation — the same mechanism a rider-initiated pause needs.
5. **Settings that affect the simulation must enter as inputs.** Otherwise replay and recovery read today's settings instead of the ride's. Settings read only by the input side (which device to connect) may be read directly.
6. **The first concrete use case exists:** persisting device choices is an open item of [ADR 0042](../decisions/0042-device-links-in-the-peripheral-link.md). A second, urgent one: the companion pairing **token is stored in WebView `localStorage`** today, which violates the secrets rule of the brief.
7. **Storage technology:** keep ride journals/recordings as JSON Lines files ([ADR 0029](../decisions/0029-recording-format-ridrs-v1.md)); use **SQLite** for structured, queryable, migratable data (machine config, profile history, calendar, provider cache, activity index, later sync metadata); **OS secure storage** for secrets.

---

## A. Existing Architecture Inventory

| Component | Where | What it does today | Limits for this brief |
|---|---|---|---|
| Logical clock, turn queue | `packages/core/src/clock.ts` (`TurnClock`, `LiveClock`, `ReplayClock`), [time-and-scheduling.md](../architecture/time-and-scheduling.md) | One logical time per turn, order `(time, tasks before inputs, seq)`, catch-up in chunks | **[Fact]** No way to hand a running host from `ReplayClock` to `LiveClock`; no notion of a gap in logical time. `LiveClock` time is epoch ms from `performance.timeOrigin + now()`, so a restart jumps logical time forward by the downtime. |
| Input queue | `ctx.inputs.accept`, `PluginHost.publishEvent`, `PluginHost.input` | Every external input is its own turn, envelope `input: true`, `receivedAt` | Exactly the journal boundary the brief asks for. |
| Envelopes and ids | `packages/core/src/plugin-host.ts` | Global `seq`, ids `<runId>:in:<n>` and `<runId>:<source>:<t>:<k>`, `runId` random per host, reused on replay (`PluginHostOptions.replay.runId`) | `runId` makes ids unique per run, not stable across runs: **not usable as persistent device ids**. |
| Host tap | `ctx.host.observe`, permission `observe-host` ([ADR 0030](../decisions/0030-host-observation-permission.md)) | Every envelope and diagnostic in global publish order | Basis of the journal writer. |
| Recording writer/reader/recovery | `packages/recording/src/{writer,reader,recovery,snapshot}.ts`, format [ridrs-recording-v1.md](../formats/ridrs-recording-v1.md) | JSONL records `header`, `snapshot`, `event`, `diagnostic`, `footer`; torn last line tolerated (`allowTornLastLine`); `recoverRecording` appends a `recovered` footer | Recovery **finalizes** an interrupted ride; it never continues it. |
| `recording-session` | `plugins/recording-session/index.ts` | 60 s pre-roll, opens `recordings/<name>.ridrs.jsonl` on `running`, appends every 1000 ms (`RECORDING_DEFAULTS.flushIntervalMs`) via `setInterval`, gzips and verifies on `finished`; at start seals every orphaned `.jsonl` as `recovered` | **[Fact]** Durability = `AppFiles.append` once per second, **no fsync**. Up to ~1 s of records lost on a process crash, an unknown amount on power loss. Orphans are sealed immediately at start, leaving no chance to continue. |
| Replay | `packages/replay`, [recording-and-replay.md](../architecture/recording-and-replay.md) | Composes a host from the recorded plugin set minus `transport`/`storage`/`recording`/`export`/`ui` plugins, adds `replay-ble-central` (finds nothing), injects recorded inputs at recorded times, `advanceTo(endedAt)`; proven identical (`tests/unit/live-replay-determinism.test.ts`, `ride-save-and-replay.feature`) | This **is** the state-reconstruction engine recovery needs. Excluding I/O plugins already prevents side effects during replay. |
| Config snapshot | `config.snapshot` capability ([ADR 0036](../decisions/0036-config-snapshot-capability.md)), `packages/recording/src/snapshot.ts` | Each physics plugin reports its effective parameters; recorded in the `snapshot` record; replay **reports** differences, applies none | Values are code defaults (`PhysicsParameter.origin: 'default'`). Once they come from a profile, the snapshot alone does not make replay use them (see C.4). |
| File storage | `storage.app-files` ([ADR 0031](../decisions/0031-app-files-storage-capability.md)): `storage-files-node` ([ADR 0037](../decisions/0037-app-data-directory-env-paths.md), env-paths, `RIDRS_DATA_DIR`), `storage-files-tauri` ([ADR 0038](../decisions/0038-tauri-plugin-fs.md), scoped to `$APPDATA/recordings/**`), `fixture-storage-memory` | `append`, `write`, `read`, `list`, `remove`; path validation `assertAppFilePath` | No `sync`/fsync, no atomic replace (write-temp-then-rename), single global namespace. |
| Activity lifecycle | `plugins/activity-session/index.ts` | `idle → running → finished`, `sessionId = ctx.ids.next()`, `startedAt = ctx.clock.now()` | No pause, no interruption, no resume. |
| Physics schedule | `plugins/physics-engine` ([physics.md](../architecture/physics.md)) | Step 0 as a task at `startedAt`, step n at `startedAt + 10·n` | A restart in the middle would run every missed step (catch-up) as simulated riding. |
| Temporal / spatial layers | `packages/core/src/temporal-service.ts`, `spatial-service.ts`, [temporal-data-layer.md](../architecture/temporal-data-layer.md) | 60 s / 600-sample history per series, freshness, staleness | State is fully derived from inputs: rebuilt by replay; after a gap series become stale/unavailable by themselves. |
| Device registry and links | `plugins/device-registry`, `packages/ble-peripheral/src/link.ts`, [ADR 0042](../decisions/0042-device-links-in-the-peripheral-link.md) | Status per kind, candidates, routes; device ids from first sighting | **[Fact]** "The choices last for this run; persisting them waits for the storage design" (ADR 0042, [devices-and-metrics.md](../architecture/devices-and-metrics.md), [ui-and-activity.md](../architecture/ui-and-activity.md)). |
| BLE writes | `packages/ble-peripheral/src/link.ts:362` | Only a connection **handshake** (Zwift Ride) is written today | No trainer control yet; ADR 0029 anticipates `device.raw-write` / `trainer.command`. |
| Secrets | `plugins/bridge-connector-tauri/tauri-bridge-connector.ts:16` (`PAIRING_KEY`, `webStoragePairingStore`), `apps/companion/src/platform.ts` | Bridge pairing **including its token** in WebView `localStorage`; companion's id and issued tokens likewise | **[Fact]** Secret in ordinary storage. No Keychain/Keystore integration. |
| Window state | `tauri-plugin-window-state` ([ADR 0041](../decisions/0041-window-state-tauri-plugin.md)) | Rust-side, desktop only | Already machine-local config; stays outside the new store. |
| Databases | — | **[Fact]** No SQLite, no key-value store, no `tauri-plugin-store`/`plugin-sql`/Stronghold in the repo | Greenfield. Node 26 (installed: v26.10.0) ships `node:sqlite`. |
| Test infrastructure | Cucumber (strict) + Vitest + execa ([ADR 0002](../decisions/0002-testing-cucumber-vitest-execa.md)), fake timers ([ADR 0011](../decisions/0011-fake-timers-sinon.md)), `tests/support/world.ts`, `fixture-storage-memory`, e2e on real timers | Process-level runs of `apps/headless` and the native app | No fault injection on storage yet (torn writes, lost unsynced bytes, `SIGKILL` mid-ride). |

---

## B. Refined Data Ownership Model

### B.1 Observations on the five-domain model

- **[Challenge] Secrets are not a domain but a storage class.** They belong to a domain (the bridge pairing token is machine config; an OAuth token is a machine-local credential for a user-level provider binding) but are always stored in secure storage and never synchronized. Model them as a cross-cutting rule, not a sixth bucket.
- **Session data and session recovery data are one lifecycle, two phases.** An open journal *is* the recovery data; a sealed journal *is* the completed activity. Splitting them into separate stores would create exactly the parallel implementation the brief warns about. They stay separate *responsibilities* (journal writer, recovery procedure, activity index) on one artifact.
- **Missing domain: caches and derived data** (provider caches, the activity index, FIT exports). Always reconstructible or re-fetchable, never authoritative, may be deleted. Naming it prevents caches from silently becoming owned data (brief §2.3).
- **Overlaps that need a rule:**
  - *HUD layout*: a user preference, but its fit depends on screen size. → user-scoped layout, machine-scoped override if ever needed (not now).
  - *Units*: user. *Audio output device*: machine. *Language*: user.
  - *A heart-rate strap the rider carries between machines*: still machine config (platform identifiers differ per machine and OS); at most a user-level "display name" hint later.
  - *Provider selection vs credential*: binding is user-scoped and synchronizable; the token is machine-local and secure. A binding without a local token is "needs sign-in on this device".
  - *Plugin-owned settings*: belong to the domain of their scope (machine or user), namespaced by plugin id; the plugin owns the schema, the user owns the values.

### B.2 Domains

| Domain | Owner | Authoritative source | Local storage | Sync policy | Retention | Recovery | Access |
|---|---|---|---|---|---|---|---|
| **Machine configuration** (known devices, device choice per kind, link preference, auto-connect, companion pairing metadata, audio/display, window state) | this installation | local store | SQLite `machine_*` tables; window state stays in its Tauri plugin | never | until changed, "forget device", or uninstall | not session state; read again at start | input-side plugins via scoped settings (C.5); never simulation plugins |
| **User profile and preferences** (mass, height, FTP history, HR max/threshold, zones, units, HUD layout, training preferences) | the user | the bound provider; "local" = ridrs | SQLite `user_*` tables; effective-dated history rows | optional, per sub-domain, off by default | user data: until deleted; history is append-only | simulation-relevant values are captured as session inputs at ride start (C.4) | via typed repositories; simulation reads only through inputs |
| **Provider bindings** | the user | local store (later the ridrs account) | SQLite `provider_binding` | synchronizable | until changed | no | settings UI, provider facade |
| **Domain data** (athlete profile, calendar, workouts, plans) | the bound provider | local → ridrs; Intervals.icu → Intervals.icu | owned data in SQLite; external data only as **cache rows with provenance** | owned local data: optional; external: never (re-fetched) | owned: until deleted; cache: evictable | a workout used by a ride is snapshotted into the session as an input | provider facade per domain |
| **Session** (active: open journal; completed: sealed recording, FIT, index row) | the user | the journal file | `recordings/<name>.ridrs.jsonl` → `.ridrs`; index row in SQLite (reconstructible from files) | completed activities: later, opt-in; active: never | completed: until deleted (no retention policy yet); open: until continued or finished | **yes**: the open journal is the recovery source | `recording-session` (writer), recovery procedure (composition root), activity index |
| **Caches / derived** (provider caches, activity index, FIT) | ridrs | derived from another domain | SQLite / files | never | evictable | no | owners only |
| **Secrets** (bridge token, OAuth refresh/access tokens, companion-issued tokens) | the user, per installation | secure storage | macOS Keychain, Android Keystore-backed storage; in Node a test/dev fallback | **never** | until revoked or forgotten | no | only the plugin that created them, via a scoped secure-storage capability |

### B.3 Proposed sync defaults (refines the brief's table)

| Data | Default | Note |
|---|---|---|
| Bluetooth devices, platform identifiers, link preference, companion pairing | local | |
| Audio output, display, window | local | |
| Units, HUD layout | sync when the user enables sync | low conflict risk, last-writer-wins acceptable |
| Mass, height | sync, **effective-dated** | weight is history too (FIT, analysis) |
| FTP, thresholds, zones | sync, **append-only effective-dated entries** | never last-writer-wins on a single value |
| Provider bindings | sync | token stays local |
| Local calendar, own workouts | sync when enabled | needs per-record revisions and tombstones |
| External calendar/workouts | not synced; owned by the provider | caches are per device |
| Active session journal | local | |
| Completed activities | later, opt-in | large; upload to providers is a separate concern (intervals.icu upload) |
| Secrets | never | |

---

## C. Refined Architecture

```text
                         ┌──────────────────────────── composition root (apps/native, apps/headless) ──────────────────────────────┐
                         │  LocalDatabase port (SQLite)   SecureStorage port   AppFiles (+ sync)   Recovery procedure (uses replay)  │
                         └───────┬───────────────────────────┬───────────────────┬────────────────────────┬─────────────────────────┘
                                 │ repositories               │ secrets           │ journal files          │ ReplayClock → LiveClock
 input side (may do I/O):        ▼                            ▼                   ▼                        ▼
   ble-peripheral link ◄── settings.machine ── device choices      recording-session = journal writer ◄── ctx.host.observe
   bridge-connector    ◄── secrets.scoped ──── pairing token         (header, snapshot, every envelope, durable sync)
   ui-* (settings UI)  ──► repositories ──► user/machine settings
   profile driver      ──► ctx.inputs.accept(rider.profile-applied …)  ─┐
                                                                         ▼
 simulation side (deterministic):  turn queue ─► activity-session ─► physics-* / temporal / spatial
                                                (running ⇄ interrupted/paused ⇄ running → finished)
 providers (later):  athlete-profile-source / calendar-source capabilities (multiple) + binding ─► provider facade ─► cache with provenance
 sync (later):       SyncService over syncable repositories only (revision, tombstone, origin), never over the whole DB
```

**Generic infrastructure:** `LocalDatabase` port and its two adapters, migrations runner, `SecureStorage` port and adapters, `AppFiles.sync`, scoped settings access, the recovery procedure in the composition root, the core's clock handover. **Domain-specific:** repositories (machine devices, profile history, bindings, activity index), the profile driver, provider facades, the journal *content* (it remains the ridrs recording format).

### C.1 Storage technology

- **[Proposal] SQLite for structured data**, behind a `LocalDatabase` port owned by the composition root (like `TimeSource`/`TimerPort`), so the core and plugins never see SQL:
  - Node/headless/tests: `node:sqlite` (built into Node 26, no dependency; verify its stability status for the pinned Node version in the ADR).
  - Native (macOS, Android): the official `@tauri-apps/plugin-sql` (sqlx, supports mobile) **or** a small own Rust command on `rusqlite`. ADR decides; the official plugin is preferred per rule 2.
  - One SQL dialect, one migration list (`migrations/NNNN-*.sql` in a new package), applied in a transaction at open; `PRAGMA user_version` holds the schema version; `journal_mode=WAL`, `synchronous=FULL` for the config DB (writes are rare).
- **[Challenge] Machine config alone does not need SQLite** (a few devices fit a JSON document with atomic replace). It is proposed anyway because the next domains (FTP history, calendar, provider caches with provenance, sync revisions, activity index) need transactions, queries and migrations, and introducing the database with the smallest use case is the lowest-risk moment. **[Open]** If the maintainer prefers, Phase P1 can use per-domain JSON documents (`config/machine/devices.json`, write-temp-then-rename) and SQLite arrives with the athlete profile; the repository interfaces below stay the same.
- **Journals stay files** ([ADR 0029](../decisions/0029-recording-format-ridrs-v1.md) already chose JSONL over SQLite for append-while-riding, portability and debuggability). SQLite only indexes them (`activity` rows: session id, file, status, distance, duration), and the index is reconstructible from the files.
- **One database file** (`ridrs.db` in the app data directory), separate table groups per domain. No second database, no generic key-value table for app data.

### C.2 Secure storage

- **[Proposal]** `SecureStorage` port: `get/set/delete(key)` of opaque strings, keys namespaced by plugin id. macOS Keychain and Android Keystore via a Tauri plugin (candidates to evaluate in the ADR: a keyring-based community plugin vs. own commands on the `keyring` crate vs. Stronghold, which is official but brings its own vault and password model). Headless/tests: an in-memory or file fallback that is **clearly marked insecure** and only allowed with `RIDRS_DATA_DIR` set.
- First users: the bridge pairing token (move it out of `localStorage`; keep non-secret pairing metadata in machine config), then intervals.icu OAuth tokens.

### C.3 The session journal (= the recording, made durable)

The recording file already contains everything recovery needs: header (`sessionId`, `runId`, `startedAt`, platform, plugin set via the snapshot), every input with time, id, source and payload, and the derived events. Changes:

1. **Commit unit = a complete line of the open `.ridrs.jsonl`.** A torn last line is not committed (already the reader's rule).
2. **Durability policy** (proposal, numbers to be confirmed by measurement):
   - append every 1000 ms as today (process crash: ≤ ~1 s plus the write in flight is lost; data handed to the OS survives a process kill);
   - `sync` (fsync; on macOS `F_FULLFSYNC`) every 5 s and **immediately** after lifecycle inputs (`running`, interruptions, `finished`, rider actions such as lap/workout start later);
   - guarantee stated honestly: *after power loss, at most the last ~6 s of journal records are lost on storage that honors flush commands; the recovered ride is exactly the ride as if those inputs had never arrived.* No claim beyond that (drives or VMs that ignore flushes, file systems in unusual modes).
   - `AppFiles` gets `sync(path)`: in Node `FileHandle.sync()` (note: plain `fsync` on macOS is not a full flush; the ADR must decide whether `F_FULLFSYNC` is needed in headless), in Tauri a Rust command using `File::sync_all` (Rust's std uses `F_FULLFSYNC` on Apple platforms — verify for the pinned toolchain). `@tauri-apps/plugin-fs` has no fsync, so this is a small own command or a fork-free extension; ADR needed.
3. **[Challenge] Inputs are not held back until committed.** The turn queue is synchronous and must not wait for I/O (and BLE arrives at several Hz per device). Consistency does not need it: since state is a pure function of the input prefix, recovery reconstructs a state that *did* exist (the state after input k), never a mixture. What is lost is the tail after the last committed line. **The brief's rule 9 is reformulated accordingly** (section H, rule 9).
4. **Effects that leave ridrs** and must not be lost or repeated (trainer target commands when they arrive, uploads, notifications) are produced from simulation state by input-side plugins. They must be idempotent with respect to current state (a trainer gets "the current target", not "+10 W"), or wait for commit (outbox). Recovery never re-sends historical commands: the replay excludes input-side plugins already.
5. **Journal size:** the journal contains derived events too (≈ 80 MB/h raw, estimate in ADR 0029). Recovery only needs inputs, header and snapshot. Keeping derived events preserves today's replay comparison and the FIT export; the write rate (~22 KB/s) is harmless for SSD wear. **[Open]** Whether derived high-rate events (`physics.state-batch`) should move out of the journal later is a recording-format question, not a recovery prerequisite.

### C.4 Session snapshot: settings that affect the simulation enter as inputs

- **[Fact]** Today `config.snapshot` records code defaults and the replay only reports differences. Once rider mass or FTP come from a profile, a replay or a recovery on the same machine would read the **current** profile and silently diverge.
- **[Proposal]** A driver on the input side (e.g. `profile-driver`) accepts the effective, simulation-relevant profile values as an **input event** (e.g. `rider.profile-applied { mass, ftp, … , provenance: { provider, recordId, revision, fetchedAt } }`) before or at ride start. Physics plugins read it — per AGENTS.md rule 11 through a reader or a lifecycle-scoped mechanism, not a data subscription (the exact path needs its own ADR, like ADR 0044 did for terrain). Consequences:
  - The value is in the journal → replay and recovery use the ride's values automatically.
  - The session's configuration is "the inputs before step 0 + `config.snapshot`". No separate snapshot store, no copy of the database.
  - A change during the ride is either refused for the running session (default: session-scoped values are fixed at `running`) or is itself an input with a defined effect time.
- Machine config read by the **input side** (which device to connect, which link) does not need this: it influences which inputs arrive, and the inputs are journaled.

### C.5 Plugin persistence access

- **[Proposal]** No raw database access for plugins. Two narrow access paths:
  1. **Scoped settings documents** for plugin-owned configuration: `ctx.settings.machine` / `ctx.settings.user`, each `{ read(): Promise<T | undefined>; write(value: T): Promise<void> }` bound to the plugin id and a zod schema with a `schemaVersion`. Granted only when the manifest declares it (new manifest field, e.g. `"persistence": ["machine"]`, same pattern as `permissions: ["observe-host"]`). Only input-side plugins (types `transport`, `ui`, `storage`, drivers) may declare it; a simulation plugin declaring it is `invalid-manifest`, enforced like the `outside-turn` rule.
  2. **Domain repositories** as capabilities for cross-plugin domain data (device registry, profile history, bindings), provided by a storage plugin that receives the `LocalDatabase` port from the composition root.
- **Removal of a plugin** leaves its namespace untouched (orphaned, listed by a later "storage" diagnostics view); a replaced plugin with a new id starts empty unless it ships an explicit import. **[Open]** Whether orphaned namespaces are cleaned up after N days.
- **Migration:** each settings document carries `schemaVersion`; the plugin supplies `migrate(from, value)`; unreadable data is reported (`settings-invalid`) and treated as absent, never thrown at start (same spirit as `webStoragePairingStore` today).
- **Recovery participation:** none needed for v1 — simulation plugin state is rebuilt by replay. Only if checkpoints arrive (section E.2) do simulation plugins need a `checkpoint.state` contract.

### C.6 Recovery procedure (v1, without checkpoints)

At host start, `recording-session` finds an open journal whose last record does not belong to a `finished` cascade. Instead of sealing it immediately:

1. Publish `session.recoverable { sessionId, file, lastRecordAt, distance }`; the main screen offers **Continue ride** / **Finish ride** (keyboard-first, AGENTS.md rule 12). **[Open]** default after a timeout, and whether headless continues automatically.
2. **Finish:** today's path (`recoverRecording` → `recovered` footer → seal → `recording.completed` → FIT).
3. **Continue** (composition root):
   1. Read and parse the committed prefix; check plugin set and versions against the recorded snapshot. Any difference in a simulation plugin → continuation refused with a clear reason, fall back to Finish.
   2. Compose the host with the recorded `runId` on a `ReplayClock` starting at the recorded start (existing `PluginHostOptions.replay`); input-side plugins are composed but **not started** yet.
   3. Inject every committed input in recorded order (existing `injectInput`), `advanceTo(lastRecordAt)`.
   4. Inject the input `activity.interrupted { sessionId, lastRecordAt }` **at `lastRecordAt`** (so no task after that time runs as riding). `activity-session` moves to `interrupted`; `physics-engine` cancels its step task (the integrator state is kept).
   5. **Clock handover (new core feature):** the turn queue continues on a live time source; logical time jumps from `lastRecordAt` to `now` while no simulation task is scheduled in between. Pending tasks of other plugins in the gap run at their planned times (catch-up) — they must not represent riding; this is why the pause has to cancel the physics schedule.
   6. `recording-session` re-attaches to the same open file, sets its writer `seq` to the file's last `seq`, appends the interruption input and continues. No duplicate lines: the replay phase does not write.
   7. Start the input-side plugins: links reconnect, the temporal layer marks series stale until fresh measurements (it does by itself), the UI shows the ride paused with "Waiting for devices".
   8. The rider (or, **[Open]**, automatically on fresh power) issues `activity.resume-requested`; `activity-session` → `running` with the **same `sessionId`**; `physics-engine` schedules step n at `resumedAt + 10·k`, continuing step numbers and distance.
- **Times kept apart:** logical time (continuous epoch ms, includes the gap), wall time (`receivedAt`), active time (sum of running intervals, derived from activity states), interruption (`lastRecordAt` → `resumedAt`; the true crash time lies between the last committed record and the next start, so the interruption is an upper bound and is recorded as such). The FIT export maps interruptions to timer stop/start events.
- **Replaying a continued ride later** works unchanged: the interruption is an input; the replay clock advances through the gap with no physics task scheduled.

---

## D. Concrete Contracts and Data Models

Minimal, only what P1–P3 use; names follow existing conventions (`*Capability`, `define*`, zod schemas in contracts). Illustrative TypeScript.

```typescript
// --- scopes -----------------------------------------------------------------------------------
type PersistenceScope = 'machine' | 'user';          // 'session' = the journal, not a settings scope

// manifest.json addition (validated by manifestSchema)
//   "persistence": ["machine"]       // grants ctx.settings.machine; simulation plugin types may not declare it

interface ScopedSettings<T> {
  read(): Promise<T | undefined>;                    // undefined: absent or unreadable (diagnostic reported)
  write(value: T): Promise<void>;                    // atomic replace, committed when resolved
}
interface SettingsDocument<T> {
  readonly schemaVersion: number;
  readonly schema: z.ZodType<T>;
  migrate?(fromVersion: number, value: unknown): T;
}

// --- storage ports (composition root → storage plugin) ----------------------------------------
interface LocalDatabase {
  transaction<R>(work: (tx: SqlTransaction) => Promise<R>): Promise<R>;
}
interface SqlTransaction {
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  all<Row>(sql: string, params?: readonly SqlValue[]): Promise<readonly Row[]>;
}
interface SecureStorage {                            // keys are namespaced by plugin id by the provider
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
interface AppFiles { /* existing */ sync(path: string): Promise<void>; }   // new: durable once resolved

// --- machine config: devices (P1) --------------------------------------------------------------
interface KnownDevice {
  readonly ridrsDeviceId: string;                    // stable, created on first sighting, never a runId-based id
  readonly kind: DeviceKind;                         // existing contracts type
  readonly displayName: string;
  readonly protocol: 'ftms' | 'heart-rate' | 'zwift-ride';   // only protocols that exist
  readonly identifiers: readonly {                   // per route; platform ids differ per OS and machine
    readonly route: 'local' | 'companion';
    readonly platformIdentifier: string;             // CoreBluetooth UUID, Android address, companion-side id
  }[];
  readonly firstSeenAt: string;                      // ISO wall time: config is not simulation state
  readonly lastConnectedAt?: string;
}
interface DeviceChoice {
  readonly kind: DeviceKind;
  readonly ridrsDeviceId: string;
  readonly preferredRoute?: 'local' | 'companion';   // ADR 0042: whose data is used
  readonly autoConnect: boolean;                     // false after an explicit Disconnect
}
interface MachineDeviceRepository {
  known(): Promise<readonly KnownDevice[]>;
  remember(device: KnownDevice): Promise<void>;
  forget(ridrsDeviceId: string): Promise<void>;      // also removes its DeviceChoice, in one transaction
  choices(): Promise<readonly DeviceChoice[]>;
  choose(choice: DeviceChoice): Promise<void>;
}

// --- user profile (P5): effective-dated, append-only -----------------------------------------
interface ProfileEntry<K extends 'mass' | 'ftp' | 'hrMax' | 'hrThreshold', V = number> {
  readonly entryId: string;                          // globally unique (sync later)
  readonly key: K;
  readonly value: V;
  readonly effectiveFrom: string;                    // ISO date
  readonly recordedAt: string;
  readonly deletedAt?: string;                       // tombstone, never a hard delete once sync exists
  readonly provenance: Provenance;
}
interface Provenance {
  readonly provider: string;                         // 'local' | 'intervals-icu' | …
  readonly externalId?: string;
  readonly revision?: string;
  readonly fetchedAt?: string;
  readonly stale?: boolean;                          // derived from fetchedAt and provider policy
}

// --- providers (P7): one contract per domain, capabilities explicit -----------------------------
interface AthleteProfileSource {
  readonly provider: string;
  readonly supports: ReadonlySet<'read' | 'update' | 'history'>;
  current(): Promise<AthleteProfile>;
  history?(key: ProfileEntry<never>['key']): Promise<readonly ProfileEntry<typeof key>[]>;
  update?(change: AthleteProfileChange): Promise<void>;
}
// capability 'profile.athlete-source' (multiple); binding picks one:
interface ProviderBinding {
  readonly domain: 'athlete-profile' | 'calendar';   // grows with real use cases
  readonly provider: string;
  readonly scope: PersistenceScope;                  // 'user' for both today
  readonly boundAt: string;
}

// --- session / journal / recovery -----------------------------------------------------------
// The journal *is* ridrs recording v1. New, backwards-compatible additions (formatVersion stays 1):
//   events activity.interrupted { sessionId, lastRecordAt }, activity.resume-requested {},
//   activity.state-changed gains { state: 'interrupted', sessionId, startedAt, interruptedAt }
//   (and 'paused' if the rider pause lands first; one state may serve both, with a reason).
interface SessionRecoverable {                       // event session.recoverable (input of recording-session)
  readonly sessionId: string;
  readonly file: string;
  readonly lastRecordAt: number;                     // logical ms of the last committed record
  readonly distance?: number;
  readonly continuable: boolean;
  readonly reason?: 'plugin-version-changed' | 'plugin-missing' | 'unreadable';
}
interface ActivityIndexRow {                         // reconstructible from files
  readonly sessionId: string;
  readonly file: string;
  readonly status: 'open' | 'complete' | 'recovered';
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly activeMs?: number;
  readonly interruptions: number;
  readonly distance?: number;
}

// --- versions ---------------------------------------------------------------------------------
//  ridrs recording formatVersion (existing) · database PRAGMA user_version · SettingsDocument.schemaVersion
//  · plugin manifest version (existing, compared at recovery) · checkpoint formatVersion (only if E.2 lands)
```

---

## E. Failure and Recovery Analysis

### E.1 Scenarios (v1: journal prefix + replay)

| Scenario | Behavior | Guarantee |
|---|---|---|
| Crash immediately after receiving an input | The input was in memory only (not yet appended). Recovery replays the committed prefix; the input never happened. | State = state after the last committed input. |
| Crash after journal append, before processing | Not possible in the current order (the observer sees the envelope at publish time, in its turn); if appended, it was processed. On recovery it is replayed exactly once. | No double application: there is only one source (the journal) and no checkpoint. |
| Crash during a processing turn | Turns are synchronous; lines are queued in memory and appended between turns, so a partial turn may reach the file only partially (a batch ends mid-cascade). Replay re-executes the whole turn of every committed input; derived lines of a partial turn are regenerated in memory and not compared. | The recovered state is the full turn of every committed input. **[Proposal]** The writer cuts append batches only at turn boundaries, so the file never ends mid-cascade except by a torn write. |
| Torn / partially written last line | Dropped (existing `allowTornLastLine`). | Committed = complete lines. |
| Corrupt line in the middle | Should not happen with append-only writes; if it does: recovery stops at the corrupt line only when it is within the last unsynced window, else continuation is refused, the file is kept untouched and reported (`recording-corrupt`). | Never silently skip an input in the middle; never delete user data. |
| Crash during checkpoint creation | n/a in v1. With checkpoints (E.2): temp file + rename + fsync of the directory; a missing/invalid checkpoint falls back to the previous one or to the journal start. | |
| Crash after processing, before persistence | The tail after the last committed line is lost (≤ 1 s process crash, ≤ ~6 s power loss per C.3). | Bounded, documented loss. |
| Corrupt latest checkpoint | n/a in v1 (replay from start). With checkpoints: verify `formatVersion`, checksum and that its watermark line exists in the journal; else use the previous one. | |
| Plugin version change between recording and recovery | Detected from the snapshot (existing replay comparison of plugin versions). Simulation plugin changed → `continuable: false`, Finish only. Input-side plugin changed → allowed (they are not replayed). | Never continue on code that could compute a different state. |
| App updated mid-interruption (any plugin) | Same as above; the update path should prefer finishing open rides. | |
| Device missing after restart | Links search as usual; series stay `unavailable`/stale; the ride stays `interrupted` until resumed; resume without power means coasting, as today when power is lost. | No invented values. |
| External provider unavailable | The ride uses the profile values journaled at its start; a new ride uses the cached values with `stale: true` and shows it; nothing blocks riding. | Rides never depend on network. |
| Interrupted cloud sync (later) | Sync is per record with revisions and an idempotent push/pull log; a retry resumes from the last acknowledged revision. | Local data is never modified by an incomplete sync. |
| Crash while sealing (`.ridrs` written, `.jsonl` not yet removed) | Existing behavior: footer present → kept as is and sealed again; read-back check before removal. | |
| Crash during recovery's replay phase | Nothing was written during replay; next start begins again. | Recovery is idempotent until step C.6.3.6. |
| Database (config) crash mid-write | SQLite transaction with WAL + `synchronous=FULL`: the write either happened or not. | Atomic per repository call. |

### E.2 Checkpoints (deferred; design sketch so v1 stays compatible)

Introduce only if measured recovery time of a long ride exceeds the budget (proposal: 5 s for a 3 h ride on the target Mac, **[Open]** for Android).

- Boundary: after a complete turn, at a turn index `k` (envelope `seq` and journal line number recorded as the **watermark**).
- Contents: logical time, `runId` counters (input number, per-source counters for ids, `seq`), each simulation plugin's state via a new `checkpoint.state` capability (`{ section, version, save(): JsonValue, restore(value) }`), temporal and spatial service state, and **no** callbacks or timer handles: plugins re-create their scheduled tasks from their restored state (`physics-engine`: next step time from the last step number). Any plugin with scheduled work it cannot re-derive must say so in its `checkpoint.state` — today that would be only `physics-engine`.
- Commit: write `checkpoints/<sessionId>/<n>.json` to a temp name, fsync, rename, fsync the directory; the checkpoint is valid only if its watermark line exists in the journal and its checksum matches.
- Recovery with a checkpoint: restore, then inject inputs **after** the watermark line. **Verification option:** in development builds, compare against a full replay.
- Cost: every simulation plugin gets a serialization contract that must stay version-compatible. That is the main reason to defer.

---

## F. Performance and Durability Analysis

| Topic | Estimate / policy | To measure |
|---|---|---|
| Input rates | FTMS indoor bike data ~1–4 Hz, heart rate ~1 Hz, Zwift Ride on change, `ui.terrain-observed` / `world.terrain-preview` per landscape window, connection changes rare | actual `ui.terrain-observed` rate; inputs/s of a typical ride from a real recording (`recording inspect` counts) |
| Journal write | all envelopes, ≈ 80 MB/h raw (ADR 0029 estimate, dominated by `physics.state-batch` at 20/s), appended once per second ≈ 22 KB/s | real size per 10 min (ADR 0029 manual check is still open) |
| Sync (fsync) | every 5 s + on lifecycle inputs: ~720 full flushes/h; `F_FULLFSYNC` costs milliseconds on Apple SSDs, off the turn queue (async in the storage plugin) | latency on macOS and an Android mid-range device; no turn-queue impact (it never waits) |
| SQLite config DB | rare small transactions, WAL, `synchronous=FULL` | none critical |
| Recovery time | full replay of the prefix: 100 Hz physics = 360 000 steps/h, ~11 capability calls each, plus temporal reads | headless replay time of a 1 h and a 3 h recording; this decides checkpoints |
| Storage growth | gzip ≈ 8–12 MB/h (estimate); no retention policy yet | real numbers; **[Open]** retention (keep all vs. N days of `.ridrs`, keep FIT) |
| Storage wear | ~80 MB/h of appends is negligible for SSD endurance | — |
| Migrations | forward-only SQL migrations in one transaction; backup of `ridrs.db` (SQLite online backup / `VACUUM INTO`) before applying a migration that changes existing tables | test: migrate a fixture DB of every released schema version |
| Backup | user data = `ridrs.db` + `recordings/`; secrets are not backed up (re-pair, re-sign-in) | export/import is a later use case |

**What survives a sudden power loss (v1, on storage that honors flushes):** every committed and synced journal line (all but at most ~6 s of the ride), every completed SQLite transaction, every sealed `.ridrs`. **What can be lost:** the unsynced journal tail, a settings write whose promise had not resolved. **What is never claimed:** durability on hardware or file systems that ignore flush requests.

---

## G. Refined Implementation Plan

Each phase: failing Cucumber scenarios first, ADRs before code, ends with a vertical use case (AGENTS.md rules 1, 9). Order changed versus the brief: **the bridge token and a rider pause are pulled forward**, checkpoints are split out, providers and sync stay late.

| Phase | Scope | Reuses | New | Tests and acceptance | End-to-end result |
|---|---|---|---|---|---|
| **P0 ADRs** | Approve section H; settle [Open] questions | — | ADRs 0046–0051 | — | Decisions recorded |
| **P1 Persistence foundation + machine config: device choices** | `LocalDatabase` port, migrations, SQLite adapters (Node, Tauri), `ctx.settings.machine` with manifest declaration, stable `ridrsDeviceId`, `MachineDeviceRepository`; link reads/writes choices (ADR 0042's open item) | `storage-files-*` pattern for adapters, `fixture-storage-memory` pattern, capability resolution, `device-choice.feature`/`device-details.feature` | storage package (AGPL), migration runner, `persistence` manifest field, depcruise rule: no plugin imports SQL adapters | Scenarios: chosen trainer is connected again after restart; Disconnect survives restart (no auto-connect); Forget removes it; unreadable config → `settings-invalid`, app still starts; a simulation-type manifest declaring `persistence` is `invalid-manifest`; e2e: native app restart keeps the choice | Devices and choices survive restarts on macOS and headless |
| **P2 Secure storage** | `SecureStorage` port, Keychain/Keystore adapter, insecure Node fallback only with `RIDRS_DATA_DIR`; move bridge pairing token (and companion tokens) out of `localStorage` with a one-time migration | `PairingStore` interface in `bridge-connector-tauri` (swap its implementation) | secure-storage plugin(s), Tauri capability entries | Scenarios: pairing survives restart; token is not in `localStorage` after migration; missing Keychain access → pair again, no crash | Secrets in OS secure storage |
| **P3 Durable journal** | `AppFiles.sync`, sync policy (5 s + lifecycle), batches cut at turn boundaries, `activity` index rows | `recording-session`, `RecordingWriter`, reader, `recoverRecording` | Rust `sync` command, Node `FileHandle.sync()` | Fault injection in a storage fixture: drop unsynced bytes, tear at every byte offset of the last batch → reader yields a prefix; property test: replay(prefix) is deterministic and equals the live state at that input | Recording loss bounded and documented |
| **P4 Pause and interruption** | `activity` states `paused`/`interrupted`, `activity.pause-/resume-requested`, `activity.interrupted`; physics schedule rebased on resume; HUD shows paused; FIT timer stop/start | `activity-session`, `physics-engine`, `export-fit`, replay | event definitions, `activity.feature` scenarios | Rider pauses 2 min: distance unchanged, active time excludes the pause, replay identical; FIT has the pause | A ride can be paused and resumed — a real use case and the recovery prerequisite |
| **P5 Continue an interrupted ride** | C.6: `session.recoverable`, Continue/Finish UI, plugin-set check, clock handover in the core, recorder re-attach | replay host (`PluginHostOptions.replay`, `injectInput`, `advanceTo`), `recording-session`, P3, P4 | core: `ReplayClock` → `LiveClock` handover; composition-root recovery procedure (headless first) | Headless `SIGKILL` mid-ride (execa) → restart → Continue → same `sessionId`, distance continues, interruption recorded, sensors stale until fresh data, no handshake/command replayed; plugin version changed → only Finish; final `.ridrs` replays identically; native e2e on macOS | A crashed ride continues with its identity |
| **P6 Measure, maybe checkpoints** | Benchmark recovery of 1 h/3 h recordings; only if over budget: `checkpoint.state` and E.2 | replay | (conditional) checkpoint writer/reader | Recovery time under budget; with checkpoints: checkpoint+tail equals full replay | Recovery fast enough on long rides |
| **P7 Local athlete profile** | Effective-dated profile entries (mass, FTP, HR), settings UI, profile values enter rides as an input (C.4); `physics-rider` mass from profile (`origin: 'profile'`) | `config.snapshot`, `PhysicsParameter.origin`, ui-sdk | profile repository, `profile-driver`, ADR for the physics read path | Change mass between rides → next ride uses it, old ride replays with the old one; change during a ride does not affect it | Rider-specific physics |
| **P8 Local calendar / workouts** | Only when a workout use case exists (ERG/structured workouts) | P7 | calendar repository | — | Local training planning |
| **P9 Providers** | `profile.athlete-source` (multiple) + binding, cache with provenance, intervals.icu as the first external provider (OAuth tokens in P2's secure storage) | intervals.icu connect use case (memory), capability system | provider facade, cache tables | Provider offline → stale cache used and shown; switching provider never merges data | Interchangeable profile source |
| **P10 Sync, P11 more providers** | As in the brief, on the revision/tombstone/effective-date rules already in the schema | all above | `SyncService` | — | — |

---

## H. Architecture Decision Records

| ADR | Title | Decision (proposed) | Rationale | Consequences |
|---|---|---|---|---|
| 0046 | Data ownership and persistence domains | The domains of B.2; secrets as a storage class; caches as a named domain; every table/document declares domain, owner, sync policy, retention | Prevents "settings" as a dumping ground | New data needs a row in the ownership table (docs check) |
| 0047 | Local structured storage: SQLite behind a port | `LocalDatabase` port in the composition root; `node:sqlite` in Node, `@tauri-apps/plugin-sql` (or `rusqlite` command) in native; one DB, forward-only migrations, WAL; journals stay JSONL | Transactions, queries, migrations for upcoming domains; ADR 0029 still holds for recordings | Two adapters to test against one migration list; Android packaging check |
| 0048 | Secure storage for secrets | `SecureStorage` port, Keychain/Keystore adapter, insecure fallback only for tests/headless dev; bridge token migrates | Brief rule 12; today's token in `localStorage` | Re-pair possible when Keychain access is denied |
| 0049 | Plugin persistence scopes | Manifest field `persistence`, `ctx.settings.{machine,user}` bound to plugin id and versioned zod schema; only input-side plugin types; no SQL for plugins | Least privilege without a permission framework; mirrors `permissions: ['observe-host']` | depcruise + manifest validation enforce it |
| 0050 | The recording is the session journal; durability policy | Commit = complete line; append 1 s, sync 5 s and on lifecycle inputs; batches end at turn boundaries; inputs are not held back; stated loss bounds | Determinism makes every prefix consistent; no blocking of the turn queue | `AppFiles.sync`; new own Rust command |
| 0051 | Pause, interruption and continuing a ride | Activity states `paused`/`interrupted`; interruption as an input at the last record time; clock handover replay → live; same `sessionId`; refuse continuation on simulation plugin change | Shutdown must not become riding time; reuse replay | Core gains clock handover; FIT pause events |
| later | Simulation-relevant settings as inputs | Profile values enter as input events with provenance; read path for physics per rule 11 | Replay/recovery use the ride's values | Snapshot = inputs + `config.snapshot` |
| later | Checkpoints | Only if recovery exceeds budget; E.2 semantics | Avoid a serialization contract on every plugin until needed | — |
| later | Provider model and bindings; sync boundaries | One capability per domain, explicit `supports`, one active binding, cache with provenance; sync only syncable repositories with revisions, tombstones, effective-dated history | Brief §2.3, §3 | — |

### Proposed architecture rules (refined wording of the brief's list)

1. Every persisted piece of information belongs to one domain of the ownership table, with an owner, an authoritative source, a sync policy and a retention policy.
2. Machine configuration and user data are stored separately; machine configuration is never synchronized.
3. Each domain has at most one active provider at a time; provider selection is a user-scoped binding, independent of cloud synchronization.
4. Synchronization covers only data domains explicitly marked syncable; temporal user data is synchronized as effective-dated history, never as last-writer-wins on a single value.
5. Data from an external provider keeps its provenance and stays a cache; it never silently becomes locally owned.
6. Secrets live only in secure storage, are never synchronized, never logged and never journaled.
7. Plugins never access the database or files directly; they use scoped settings or typed repositories granted through their manifest; simulation plugins have no persistence access at all.
8. **Values that affect the simulation enter a session only as inputs**; a session's configuration is its inputs before step 0 plus its `config.snapshot`.
9. **(replaces the brief's rule 9)** The session journal is the recording. Recovery restores the state of the longest committed journal prefix; the loss bound of the durability policy is documented and tested. Effects that leave ridrs and must not be lost or repeated are idempotent or wait for commit.
10. Recovery preserves the session identity, records the interruption explicitly as an input, and never turns downtime into active or simulated riding time.
11. Replay and recovery never run input-side plugins on historical data; hardware is reconnected as a new live connection after recovery.
12. Recording, journaling and recovery share one format, one writer and one reconstruction path (the replay host); no second event log.
13. Every persisted schema (database, settings document, recording, checkpoint) carries a version and has an explicit migration or compatibility rule; recovery refuses to continue on changed simulation code.

---

## Open questions for the maintainer

1. SQLite from P1, or JSON documents first and SQLite with the athlete profile (C.1)?
2. Secure storage plugin choice for macOS/Android (keyring-based vs. Stronghold vs. own commands)?
3. Loss bound: is "≤ ~1 s on a process crash, ≤ ~6 s on power loss" acceptable, or should the sync interval be shorter?
4. Continue vs. Finish: always ask, or continue automatically (headless and after N seconds)?
5. Resume after recovery: rider-initiated only, or automatically on the first fresh power measurement?
6. Recovery time budget that would trigger checkpoints (proposal: 5 s for a 3 h ride on the target Mac)?
7. Retention policy for `.ridrs` and FIT files (none today)?
8. Licenses of the new packages (AGPL by the pattern of recording/storage, per [LICENSING.md](../../LICENSING.md)) and any new dependency need maintainer approval.
9. Should a rider pause (P4) be built as its own user-facing use case first? This proposal assumes yes.
