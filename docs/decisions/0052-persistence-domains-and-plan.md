<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0052: Persistence Domains and the Persistence Plan

Status: accepted on 2026-11-05 by the maintainer, from the proposal [persistence-and-recovery.md](../ideas/persistence-and-recovery.md). Phases P0–P5 are implemented ([ADR 0053](0053-secrets-in-an-encrypted-app-file.md) to [ADR 0057](0057-continuing-an-interrupted-ride.md)); P6 and later wait for their use cases.

## Context

ridrs keeps a ride's recording, the window state and, until now, the companion pairing in the WebView's `localStorage` and the intervals.icu token in the macOS Keychain. Device choices last one run ([ADR 0046](0046-one-link-per-device-and-signal-strength.md)). A crash ends a ride: the recording is sealed as `recovered` at the next start, the ride cannot go on. The proposal reviews a brief on persistence, providers, sync and session recovery against the code and proposes an incremental plan.

## Decision

- **Domains** as in section B.2 of the proposal: machine configuration, user profile and preferences, provider bindings, domain data, session, caches. **Secrets are a storage class, not a domain**: they belong to a domain, but always go to `storage.secrets` and are never synchronized, logged, recorded or written to app files.
- **The recording is the session journal** ([ADR 0055](0055-the-recording-is-the-session-journal.md)): no second event log; recovery replays the committed prefix with the replay host, no checkpoints until measured recovery time asks for them.
- **Values that affect the simulation enter a session only as inputs.** Machine configuration read by the input side (which device to connect) may be read directly: it only decides which inputs arrive.
- **Plan**, in this order: P0 these ADRs; P2 secrets without the Keychain (pulled forward: the macOS password prompt at every start); P1 machine configuration as plugin settings documents, the first use the remembered device per kind; P3 the durable journal; P4 pause and resume; P5 continuing an interrupted ride. Later: P6 measure recovery and maybe checkpoints, P7 the local athlete profile (SQLite arrives with it), P8 calendar, P9 providers, P10 sync.

Changes against the proposal, decided by the maintainer on 2026-11-05:

- **No OS keychain on macOS.** The legacy Keychain asked for the login password whenever the app's signature changed (every development build). Secrets go to an encrypted file instead ([ADR 0053](0053-secrets-in-an-encrypted-app-file.md)).
- **JSON documents before SQLite.** Machine configuration is a few documents; SQLite (open question 1) comes with the athlete profile, behind the same `ctx.settings` access.
- **After a crash ridrs always asks** Continue ride / Finish ride; headless continues on its own; a ride continues paused until the rider resumes it (open questions 4, 5).
- The proposal's `KnownDevice` list, `ridrsDeviceId` and `DeviceChoice.preferredRoute` are not built: since [ADR 0046](0046-one-link-per-device-and-signal-strength.md) a device is one per link and its link's id is stable on that machine, and the rider no longer picks whose data is used ([ADR 0054](0054-plugin-settings-and-remembered-devices.md)).
- The ADR numbers 0046–0051 of the proposal were taken meanwhile; the decisions are 0052–0057.

## Consequences

- New data needs a domain, an owner and a retention rule before it is stored.
- Open: the loss bound of the journal is accepted as proposed (≤ ~1 s on a process crash, ≤ ~6 s on power loss); the recovery time budget (question 6) and retention (question 7) wait for P6.
