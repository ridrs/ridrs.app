<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0073: Data Sources for the Athlete Profile and the Training Plan

Status: **accepted** on 2026-11-08 by the maintainer ("Accept all as proposed": every point the proposal left open is decided as proposed), from the proposal [athlete-data-sources.md](../ideas/athlete-data-sources.md), on the maintainer's request ("pick p7, p8. p9 should be only intervals.icu. add an interface for different data types, that can be implemented by sync providers. add data source settings to the existing settings page"). Stage D0 of that proposal; D1 to D5 are not built yet. Amends [ADR 0052](0052-persistence-domains-and-plan.md) (no SQLite and no profile history in P7) and [ADR 0060](0060-equipment-garage-and-the-frozen-bicycle.md) (the bicycle stays out of the athlete profile).

## Context

ADR 0052 left P7 (local athlete profile), P8 (local calendar) and P9 (providers) for later. Today:

- `planner-intervals-icu` reads the athlete (FTP, weight, LTHR, max HR) and 14 days of planned rides into one app state `training.plan`, keyed by the closed enum `trainingServiceSchema = ['intervals.icu']` ([ADR 0048](0048-intervals-icu-connection-and-training-plan.md), [ADR 0068](0068-app-state-and-services-beside-the-bus.md)).
- FTP and weight in the Me area and the calendar in the Training area are previews on user documents ([ADR 0059](0059-app-areas-as-a-clickable-preview.md)); nothing reads them.
- `physics-rider` uses a fixed 75 kg (`origin: 'default'`). The bicycle already enters a ride as an input and is frozen by `activity-session` (ADR 0060).
- The settings page chooses among a few options with a row of chips (`pv-chip`, `aria-pressed`), not with dropdowns.

The maintainer wants a source per data type chosen on the settings page from every provider that offers it, and workouts read from all providers.

## Decision

### Names and data types

- **Data sources, not sync providers.** A data type has one source of truth; nothing is copied or merged between stores, and switching the source copies nothing. Sync stays P10. (Name: maintainer.)
- **Three data types:**

  | Data type | Topic | Access | Source |
  |---|---|---|---|
  | Athlete profile (FTP, weight, LTHR, max HR; the name read only) | `athlete.profile` | read and write | one, chosen |
  | Planned workouts (the calendar) | `training.calendar` | read and write | one, chosen |
  | Workout library | `training.library` | read | all providers at once |

### The interface

- **On the app state and services of ADR 0068**, no new channel and no new manifest field. `defineDataType(id, dataSchema, writes)` in `@ridrs/contracts` (Apache-2.0) defines, the same way for every type:
  - the topic `<id>`, **keyed by the provider id** (`ridrs`, `intervals.icu`; manifest id pattern); its value is `{ provider, label, status: 'ready' | 'offline' | 'unavailable' | 'loading', writable, fetchedAt?, data? }`. The keys of a topic are the providers of that type: a provider offers a type by owning its key (`state.owns` in its manifest, rule 6).
  - one service per write (`athlete.profile.update`; `training.calendar.plan`, `.move`, `.remove`), **keyed by the topic**, so the host routes a write to the provider that owns the key. A provider that cannot write answers `read-only`; one that cannot reach its service answers `unreachable`.
- `trainingServiceSchema` becomes an open provider id. `training.plan` is removed: its athlete goes to `athlete.profile`, its workouts to `training.calendar`. `training.account` and its services (`connect`, `disconnect`, `refresh`, `upload`) stay: an account belongs to a provider, not to a data type.
- **The choice** is the app state `data.source`, keyed by the data type (`athlete.profile`, `training.calendar`), value `{ provider }`, with the service `data.select`. Its owner keeps it in the user document `data-sources`. The library has no choice.

### Providers

- **ridrs (this device)**, a new plugin `profile-local` (type `storage`, `"persistence": ["user"]`): always `ready` and writable. The profile is the user document `athlete` (version 1: `ftp`, `weight`, `lthr`, `maxHeartRate`, `changedAt`), migrated once from the Me area's `preview` FTP and weight. The calendar comes from the Training area's entries (P8). It is the default source of every type, so a choice is never empty.
- **intervals.icu**, the existing `planner-intervals-icu` (id, secret key and cache path unchanged), owns the key `intervals.icu` in all three topics:
  - Profile read as today; weight from today's wellness record, else `icu_weight`.
  - Profile write: weight to `PUT /api/v1/athlete/0/wellness/{today}`, FTP to `PUT /api/v1/athlete/0/sport-settings/Ride`, into the field it was read from (`indoor_ftp` if set, else `ftp`). `icu_weight` is not written (maintainer).
  - Calendar read as today (`GET …/events`); writes as `POST`, `PUT` and `DELETE …/events`.
  - Library read from `GET /api/v1/athlete/0/workouts` (and `…/folders` for the grouping).
  - New scopes for the writes and the library, expected `WELLNESS:WRITE`, `SETTINGS:WRITE`, `CALENDAR:WRITE`, `LIBRARY:READ`; **to be confirmed** against intervals.icu's OAuth documentation before stage D4 (the OpenAPI spec names none per operation). Older tokens get 403 and the rider reconnects, as in [ADR 0064](0064-ride-debriefing-and-activity-upload.md).
- **Writes are refused, not queued**, when a source cannot be reached; the UI keeps the old value and says why. A queue would be sync.
- **The first start of this version** selects intervals.icu for the profile and the calendar when its account is connected, so the next-workout card keeps showing the intervals.icu plan.

### The ride

- **The profile enters a ride as an input** (AGENTS.md rules 7 and 13), as the bicycle does: the owner of `data.source` watches the chosen profile and accepts `athlete.profile-changed { provider, ftp?, weight? }` (no name) at host start and after every change. `activity-session` freezes it with the lifecycle event `activity.athlete { sessionId, athlete }` right before `running`, beside `activity.equipment`. A change during a ride applies to the next one.
- **`physics-rider`** subscribes to `activity.athlete` (rule 11) and takes the frozen weight with the new origin `'profile'`; without it, 75 kg as before. The recording's pre-roll keeps the latest `athlete.profile-changed`; a continued ride re-enters it from the journal (ADR 0057).
- The chosen source unavailable without a cache: the ride uses the defaults, and Today's start card says so; the ridrs profile is not used in its place, since that would mix two sources (maintainer).

### The settings page

- A section **"Data sources"** in `ui-settings` with one row per data type. The profile and the calendar offer **one chip per provider** (the topic's keys), the chosen one pressed, and beside it the source's status ("Connected as …", "Offline · last loaded …", "Not connected" with Connect, which calls `training.connect`). The library row lists its providers and is not a choice. During a ride, a change says that it applies from the next ride.
- **Chips, not a dropdown** (rule 12): a focused native `<select>` takes the arrow keys, and its open list differs per platform. A picker screen replaces the chips only if a type has more than about four providers. (Chips: maintainer.)
- The Me area's FTP and weight show the chosen source's values and write through `athlete.profile.update`.

### Later

- **No SQLite and no effective-dated history** in P7: a ride freezes its own values, and intervals.icu keeps its own history. Both wait for a use case (charts of FTP or weight) behind the same access.
- **The calendar write** is "plan a library workout on a day" (with its steps), then move and remove. The Training area's own entries (rest, note, outdoor) stay in the ridrs calendar and are not written to intervals.icu (maintainer).
- **Built-in ridrs workouts**: not in these stages (maintainer); the ridrs library stays empty until riding a workout gives them a use, then they ship as files like the drivetrain specifications.
- **Riding a workout** (steps to `trainer.target-power` inputs with the frozen FTP), the use case that makes the library and the calendar worth more than a list: proposed as the next stage, with its own ADR.
- **Ride uploads as a data type** with chosen targets, once a second target exists.
- The bicycle stays a ridrs-only user document, not part of the profile.

### Stages

Each starts with failing scenarios (rule 1); scenarios as in the proposal, section F.

1. **D1** `defineDataType`, `data.source`, `data.select`, the settings section, a test fixture with two providers.
2. **D2** `profile-local` (profile), the real Me area, `athlete.profile-changed`, `activity.athlete`, `physics-rider` from the profile. No network.
3. **D3** intervals.icu as a profile source; `training.plan` split; the first-start selection.
4. **D4** writing the profile to intervals.icu (scopes).
5. **D5** planned workouts and the library from both providers, the next-workout card from the chosen source, planning a library workout on a day.

## Consequences

- New: `defineDataType`, the topics `athlete.profile`, `training.calendar`, `training.library`, `data.source`, the services `data.select`, `athlete.profile.update`, `training.calendar.plan`/`.move`/`.remove`, the events `athlete.profile-changed` and `activity.athlete`, the origin `'profile'`, the plugins `profile-local` and the owner of `data.source` (the host side of `ui-settings`, or a plugin of its own). Removed: `training.plan`, the enum `trainingServiceSchema`.
- `packages/contracts/src/app-events.test.ts` gets `athlete.profile-changed` as a simulation input, not as an app event.
- The rider's weight changes physics results: rides recorded before D2 replay with 75 kg, as they were ridden.
- Recordings hold the rider's FTP and weight (not the name) from D2 on; they are the rider's own local files.
- Writes to intervals.icu change the maintainer's real account until the OAuth client is approved; the scenarios run against the simulated intervals.icu only.
