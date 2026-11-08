<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Proposal: Data Sources for the Athlete Profile and the Training Plan (P7, P8, P9)

**Status: proposal, 2026-11-08, not yet reviewed.** It continues [persistence-and-recovery.md](persistence-and-recovery.md) and [ADR 0052](../decisions/0052-persistence-domains-and-plan.md) with phases P7 (local athlete profile), P8 (local calendar) and P9 (providers, intervals.icu only). It starts from the maintainer's idea of 2026-11-08, checks it against the code as it is today, challenges parts of it and proposes stages. Each stage starts with failing Cucumber scenarios and gets its own ADR (AGENTS.md rules 1–3).

## Summary

- One **data source interface** per data type, built on the app state and services of [ADR 0068](../decisions/0068-app-state-and-services-beside-the-bus.md): a state topic keyed by the provider plus write services routed to it. No new channel, no new manifest field.
- Three data types: **athlete profile** (read and write, one chosen source), **planned workouts** (the calendar; read and write, one chosen source) and **workout library** (read only, from every source at once).
- Two providers: **ridrs** (this device, always there, the default) and **intervals.icu** (the existing `planner-intervals-icu`, split by data type).
- A **"Data sources" section** on the settings page with one choice per data type.
- The profile enters a ride **as an input** and is frozen at its start, exactly like the bicycle ([ADR 0060](../decisions/0060-equipment-garage-and-the-frozen-bicycle.md)). Physics finally uses the rider's weight.
- **[Change]** No SQLite and no effective-dated history yet; JSON settings documents are enough for every use case in these stages.

---

## A. What exists today

| Piece | Where | State |
|---|---|---|
| User settings documents | `ctx.settings.user(document)`, scope `user`, [settings.ts](../../packages/contracts/src/settings.ts), `userDocument` in `@ridrs/ui-preview` | Built. Used by `ui-settings`, `ui-garage`, `ui-area-me`, `ui-area-training`, `ui-area-ride`, `ui-area-events`, `ui-search`. |
| App state and services | `defineState`, `defineService` (keyed routing to the owner of a key), [ADR 0068](../decisions/0068-app-state-and-services-beside-the-bus.md) | Built; the natural home for data sources. |
| intervals.icu | `plugins/planner-intervals-icu` (OAuth with PKCE, token in `storage.secrets`, cache `training/intervals-icu-plan.json`) | Reads the athlete (`GET /athlete/0`) and 14 days of planned rides (`GET /athlete/0/events`); uploads rides. Scopes `SETTINGS:READ,CALENDAR:READ,ACTIVITY:WRITE`. |
| Training contracts | [training.ts](../../packages/contracts/src/training.ts) | `training.plan` mixes the athlete and the workouts in one value; `trainingServiceSchema` is the closed enum `['intervals.icu']`. |
| Settings page | `plugins/ui-settings` | Units, language, sounds; chips (`pv-chip`, `aria-pressed`) rather than dropdowns. Apart from the language it is a placeholder: "nothing reads them yet". |
| Me area | `plugins/ui-area-me` | FTP and weight are steppers on a `preview` document. Nothing reads them. |
| Training area | `plugins/ui-area-training` | A one-week calendar preview (`workout`, `rest`, `note`, `outdoor` entries with a title only, no steps). |
| Next workout | `plugins/ui-training-plan` | Main panel card and workout screen from `training.plan`. |
| Physics | `physics-rider` | Fixed 75 kg, `origin: 'default'`. The bicycle already enters as an input and is frozen by `activity-session` (`activity.equipment`). |
| ERG | `control-erg` | Rider-set target power as input `trainer.target-power`. No workout execution. |

## B. The idea, as understood

1. Data types: planned workouts and the athlete profile (FTP, weight, …), each readable and writable.
2. Per data type, the settings page shows a dropdown of every provider that can serve it; the chosen one is the source.
3. Workouts (the library, not the calendar) may come from any provider; ridrs always uses all of them, read only.
4. An interface for the data types that providers implement.

## C. Challenges and changes

**C.1 "Sync provider" is the wrong name. [Change]** The idea picks one source of truth per data type; nothing is copied between stores. Sync (P10) means keeping two stores equal, with revisions and conflicts. Calling these "data sources" keeps P10 open and avoids promising what isn't built. Switching the source never merges or copies data (as the persistence proposal already said for P9). A one-off "copy my profile to intervals.icu" can come later.

**C.2 The interface fits ADR 0068; no new mechanism. [Proposal]** A capability (`ctx.capabilities`, cardinality `multiple`) was the persistence proposal's sketch, but since ADR 0068 app data lives beside the bus: topics keyed by owner, services routed to a key's owner. A topic keyed by the provider id already *is* the list of providers with that capability: its keys fill the choice on the settings page. See section D.

**C.3 The profile must enter the ride as an input. [Fact, AGENTS.md rules 7 and 13]** Today nothing simulated reads FTP or weight, so nothing breaks yet. Once `physics-rider` uses the weight, a replay or a continued ride must use the ride's weight, not today's. The garage solved this: hand the values over as an input at host start and after every change, freeze them when a session starts. The profile does the same. A change during a ride applies from the next ride.

**C.4 No history and no SQLite yet. [Change, amends ADR 0052]** The persistence proposal planned effective-dated, append-only profile entries and SQLite "with the athlete profile". No use case in these stages needs history: a ride freezes its own values, so replay is already correct; intervals.icu keeps its own history (weight per day in wellness records). The local provider keeps current values with a `changedAt` in a JSON document. History and SQLite wait for a use case (an FTP chart, a weight curve) and keep the same access.

**C.5 A dropdown fights the keyboard rule. [Change, AGENTS.md rule 12]** A native `<select>` takes the arrow keys while focused, so arrows no longer move the focus, and on a remote the opened list behaves differently per platform. The settings page already uses a row of chips for a choice of few (Units, Language). With two providers, chips are clearer and work with arrows, Enter and Back. If a data type ever has more than ~4 providers, a picker screen replaces the chips; not now.

**C.6 Which source is chosen first. [Proposal]** ridrs (this device) is always a provider and the default, so the choice is never empty. To keep today's behaviour, the first start of the new version selects intervals.icu for planned workouts and the profile when an intervals.icu account is connected. A disconnected source stays selectable; its row says "Not connected" and offers Connect (`training.connect`), and the data from it is the cached copy or nothing.

**C.7 Writing to intervals.icu needs new scopes and works differently per field. [Fact, from the OpenAPI spec at `https://intervals.icu/api/v1/docs`, 2026-11-08]**
- Weight lives per day in wellness records: `PUT /api/v1/athlete/0/wellness/{date}` with `weight`. The athlete's `icu_weight` exists too (`PUT /api/v1/athlete/0`). Read: today's wellness weight, else `icu_weight`. Write: the wellness record of today. **[Open]** Whether to update `icu_weight` too.
- FTP lives in the sport settings of `Ride`: `PUT /api/v1/athlete/0/sport-settings/Ride` with `ftp` or `indoor_ftp`. ridrs reads `indoor_ftp` if set, else `ftp`. **[Open]** Write the field that was read (proposed), or always `indoor_ftp`.
- Planned workouts: `POST /api/v1/athlete/0/events` (create), `PUT …/events/{eventId}` (move, rename), `DELETE …/events/{eventId}`.
- Library: `GET /api/v1/athlete/0/workouts` and `GET …/folders`.
- Scopes: the spec lists no scopes per operation. Expected: `WELLNESS:WRITE`, `SETTINGS:WRITE`, `CALENDAR:WRITE`, `LIBRARY:READ` (**to be confirmed** against intervals.icu's OAuth documentation before the ADR). Tokens from before lack them: the first write gets 403 and the rider reconnects, as with the upload scope (ADR 0064).
- Until intervals.icu approves the OAuth client only the maintainer's account can sign in; writes change the maintainer's real data, so the scenarios run against the simulated intervals.icu only.

**C.8 "Write planned workouts" has no writer in ridrs yet. [Challenge]** The only place that plans anything is the Training area preview: entries with a title, no steps. Writing those to intervals.icu would create empty events. The useful write is **"plan a library workout on a day"**: pick a workout from the library (C.9), put it on a day, and it goes to the chosen calendar source with its steps. Moving and removing planned workouts follow. So the calendar write comes after the library, not before.

**C.9 A library you cannot ride is a list. [Challenge]** ridrs has ERG (`control-erg`, `trainer.target-power` as an input) but no workout execution: a planned or library workout can be looked at, not ridden. The use case that gives the library and the calendar their worth is **"ride a workout"**: a driver turns the workout's steps into `trainer.target-power` inputs using the frozen FTP. It is outside the request; proposed as the stage right after this plan (section F, D6), and it is the reason FTP belongs in the frozen profile.

**C.10 The workout library from "all providers". [Proposal]** ridrs reads every provider's library topic and shows them together, grouped by provider, read only. Duplicates across providers are not merged (two copies with the same name stay two entries). The ridrs provider has nothing to offer until there is a use case: built-in workouts shipped as files (like the drivetrain specification files) would be the first, and are cheap. **[Open]** Ship a few built-in workouts, or leave the ridrs library empty.

**C.11 Split `training.plan`. [Change]** `training.plan` holds the athlete and the workouts; with separate sources they must be separate topics. `trainingServiceSchema` becomes an open provider id (`z.string()` with the pattern of manifest ids). `training.account` and its services stay as they are: the account belongs to the provider, not to a data type. The plugin keeps its id `planner-intervals-icu` (its secret key and cache path stay valid).

**C.12 Ride uploads are a data type too. [Suggestion]** The debriefing uploads to intervals.icu whenever it is connected. In the same model, "completed rides" is a write-only data type whose targets are chosen (several at once, like the library reads from several). Not in this plan; worth a row on the settings page once a second upload target exists.

**C.13 Offline writes are refused, not queued. [Proposal]** A queue is the beginning of sync (P10). A write to a source that cannot be reached fails with `unreachable`; the UI says so and keeps the old value. The local provider never fails this way.

**C.14 The garage stays local. [Proposal]** The bicycle document was noted for "the athlete profile with P7". intervals.icu has gear too, but nothing needs it there; the bicycle stays a ridrs-only user document. The profile freezes next to it.

## D. Contracts

Names follow the existing contracts (`define*`, zod schemas, Apache-2.0 in `@ridrs/contracts`). Illustrative.

```ts
// data-sources.ts: one helper defines a data type the same way for every provider.
export const providerIdSchema = z.string().regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/); // 'ridrs', 'intervals.icu'

export const sourceStatusSchema = z.object({
  provider: providerIdSchema,
  label: z.string(),                       // shown on the settings page
  /** Whether the data can be read now: a disconnected account is `unavailable`, a cache `offline`. */
  status: z.enum(['ready', 'offline', 'unavailable', 'loading']),
  writable: z.boolean(),                   // false for a read-only source or a token without the scope
  fetchedAt: z.number().nonnegative().optional(),
});

/**
 * A data type: topic `<id>` keyed by the provider, each value the status and the data;
 * writes (when the type has them) are services keyed by that topic, so the host routes a write
 * to the provider that owns the key. Read-only providers answer them with `read-only`.
 */
export function defineDataType<D, W extends Record<string, z.ZodTypeAny>>(id: string, data: z.ZodType<D>, writes: W) { … }

// athlete.ts (P7): what ridrs needs, nothing more.
export const athleteProfileSchema = z.object({
  name: z.string().optional(),             // read only, from the provider
  ftp: z.number().int().positive().optional(),        // W, indoor
  weight: z.number().positive().optional(),           // kg
  lthr: z.number().positive().optional(),
  maxHeartRate: z.number().positive().optional(),
});
export const athleteProfile = defineDataType('athlete.profile', athleteProfileSchema, {
  update: athleteProfileSchema.omit({ name: true }).partial(),   // service athlete.profile.update
});

// training.ts (P8): the calendar, with the existing plannedWorkoutSchema.
export const plannedWorkouts = defineDataType('training.calendar', z.object({ workouts: z.array(plannedWorkoutSchema) }), {
  plan: z.object({ date, workoutId: z.string(), from: providerIdSchema }),  // a library workout on a day (D5)
  move: z.object({ id: z.string(), date }),
  remove: z.object({ id: z.string() }),
});
export const workoutLibrary = defineDataType('training.library', z.object({ workouts: z.array(libraryWorkoutSchema) }), {});

// The choice per data type, owned by one plugin (section E).
export const dataSourceSelection = defineState('data.source', z.object({ provider: providerIdSchema }));  // keyed by data type
export const selectDataSource = defineService('data.select', { request: z.object({ key: z.string(), provider: providerIdSchema }), response: done });

// The ride's input (rule 13): only what a ride uses; no name.
export const athleteProfileChangedEvent = defineEvent('athlete.profile-changed', z.object({
  provider: providerIdSchema, ftp: …optional(), weight: …optional(),
}));
// activity-session freezes it like the bicycle: lifecycle event activity.athlete { sessionId, athlete }.
```

## E. Plugins

| Plugin | Type | Role |
|---|---|---|
| `data-sources` (new, host side; or the host side of `ui-settings`) | `ui` or `storage` | Owns `data.source` and the user document `data-sources`; provides `data.select`. Watches the selected `athlete.profile` and accepts `athlete.profile-changed` as an input at host start and after every change (the garage's pattern). |
| `profile-local` (new) | `storage` | The ridrs provider of `athlete.profile` (user document `athlete`, migrated once from `ui-area-me`'s `preview` FTP and weight) and of `training.calendar` (P8, from the Training area's preview entries); always `ready` and writable. |
| `planner-intervals-icu` | `transport` | The intervals.icu provider of all three types; owns its keys `intervals.icu` in each topic; `training.plan` goes away. |
| `activity-session` | simulation | Freezes the profile: `activity.athlete` right before `running`, next to `activity.equipment`. |
| `physics-rider` | simulation | Subscribes to `activity.athlete` (lifecycle, rule 11); mass from the profile with `origin: 'profile'`, else 75 kg default. |
| `ui-settings` | `ui` | The "Data sources" section. |
| `ui-area-me` | `ui` | FTP and weight become real: shows the selected source's values and writes through `athlete.profile.update`. |
| `ui-training-plan`, `ui-area-training` | `ui` | Read the selected calendar source; the Training area shows the library. |

**The settings section "Data sources":**

```
Data sources
  Athlete profile     [ ridrs (this device) ] [ intervals.icu ✓ ]      Connected as Alex Rider
  Planned workouts    [ ridrs (this device) ] [ intervals.icu ✓ ]      Offline · last loaded 08:12
  Workout library     ridrs, intervals.icu (all, read only)
```

One chip per provider in the topic's keys (C.5); the chosen one pressed. Next to it the chosen source's status from the topic; an unavailable source offers "Connect" (calls `training.connect`). The library row lists the providers and is not a choice. Changing the profile source during a ride says that it applies from the next ride.

## F. Stages

| Stage | Phase | Builds | Scenarios (first failing) |
|---|---|---|---|
| **D0 ADR** | — | ADR for C.1–C.14 and section D; answers to section G | — |
| **D1 The interface and the choice** | P7/P9 | `defineDataType`, `data.source`, `data.select`, plugin `data-sources`, the settings section; a test provider fixture with two providers | Settings lists every provider of a data type; the choice survives a restart; a provider that goes away falls back to ridrs; keyboard-only selection |
| **D2 Local athlete profile in the ride** | P7 | `profile-local` (profile), Me area real, `athlete.profile-changed`, `activity.athlete`, `physics-rider` from the profile | 200 W on 5 %: the climb is slower with 85 kg than with 65 kg; a change during a ride applies to the next one; a replay after a change uses the recorded weight; a recording without the input replays with 75 kg; a continued ride keeps its weight; Me's old preview values are migrated once |
| **D3 intervals.icu profile through the interface** | P9 | `planner-intervals-icu` owns `athlete.profile` key `intervals.icu`; `training.plan` split; first start selects intervals.icu when connected | Choosing intervals.icu gives its FTP and weight in Me and in the next ride; offline → cached values, marked offline; disconnect → unavailable, and the ride uses what G.3 decides |
| **D4 Writing the profile to intervals.icu** | P9 | Scopes, `athlete.profile.update` → wellness weight and sport settings FTP | Changing weight in Me writes today's wellness weight; 403 → reconnect offered, old value kept; unreachable → refused with the reason |
| **D5 Planned workouts and the library** | P8/P9 | `training.calendar` (ridrs from the Training area, intervals.icu from today's events code), `training.library` (intervals.icu workouts, optional ridrs built-ins), next-workout widget from the chosen source, "Plan on a day" from the library | The next-workout card follows the chosen source; the library shows every provider's workouts read only; planning a library workout creates it in the chosen calendar (simulated intervals.icu receives `POST …/events` with the steps); move and remove |
| **D6 Ride a workout** (suggested next, C.9) | — | A driver turning steps into `trainer.target-power` inputs with the frozen FTP | Own brief |

D1 and D2 need no network and give the first real setting; D3–D4 rework existing intervals.icu code; D5 is the largest stage and can split into calendar read, library read and calendar write.

## G. Open questions for the maintainer

1. Name: "data sources" (proposed) instead of "sync providers" (C.1)?
2. Chips instead of a dropdown on the settings page (C.5)?
3. When the chosen source is unavailable and has no cache: the ride uses the ridrs profile, or defaults only (proposed: defaults, and the start card says so)?
4. Which intervals.icu fields to write: today's wellness weight only, or `icu_weight` too; the FTP field that was read, or always `indoor_ftp` (C.7)?
5. Calendar write only as "plan a library workout", or also the Training area's own entries (rest, note) (C.8)?
6. Ship built-in ridrs workouts for the library (C.10)?
7. Ride uploads as a data type with chosen targets, now or later (C.12)?
8. Accept that history and SQLite wait (C.4, amends ADR 0052)?
