<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0078: Drafts for External Data Sources and Request Budget

Status: **proposed** on 2026-11-09, on the maintainer's request to cut the number of intervals.icu API requests (a typical day is 59 to 319 requests today). It amends [ADR 0059](0059-app-areas-as-a-clickable-preview.md) for data bound for an external API, and refers to [ADR 0075](0075-data-sources-for-the-athlete-profile-and-the-training-plan.md), C.13 (offline writes are refused, not queued). Numbers 0076 and 0077 were taken (done workouts; native snapshot) while this was written.

## Context

ADR 0059 keeps what the rider changes in an area at once. For data that stays on the device that is right. For data of intervals.icu (ADR 0075) every change is a request: ten clicks on "Raise FTP" are ten `PUT`s, and a load reads six resources (athlete, wellness, events, activities, workouts, folders) at start, after every saved ride and on every refresh. The service limits an app's requests, and a rider who rides daily reaches the limit by the page's design, not by need. Measured by reading the code: a start is 6 requests, an hour of use with a saved ride and two refreshes about 20, a session with 100 stepper clicks over 100.

## Decision

**Rule.** Data that stays local is kept at once, as before. Everything bound for an external API goes through a draft and **one explicit save per page**. Everything read from it has a validity, and a valid copy costs no request.

1. **Which sources draft.** A provider whose data lives behind an external API says so in its source status: `DataSource.remote: true` (new optional field, absent means false). The provider `ridrs` (this device) is not remote: its pages change the value at once, unchanged. The flag is minimal and is the only contract change for the pages; `writable` keeps its meaning (read-only, or a token without the scope).
2. **Me page.** The FTP and weight steppers of a remote source change a local draft only. A button "Save" (reachable with the arrows and Enter, with a visible focus) is enabled only when the draft differs from the loaded value. Back with an open draft discards nothing silently and sends nothing: it moves the focus to "Save" and offers "Save" and "Discard" (the pattern of `ui-debriefing`). One `athlete.profile.update` call carries both fields. 75 to 80 and back to 75 is no change: Save stays disabled. A refused save keeps the draft and says why.
3. **Plugin guard.** `planner-intervals-icu` sends only the changed fields (at most two requests, the wellness weight and the sport settings FTP; none when the value equals the held one) and sends no move to the day a workout is on.
4. **Training page.** Planning and moving workouts of a remote calendar are sent when the workout is dropped, one request each, through the gateway (item 6). The rider sees the result of a drop, so it has no draft, no "Save" and no "Discard" (amended on the maintainer's request after the first version collected them in a draft list; a drafted entry could not be moved again). The change is shown at once as "Saving…" and taken back, with the reason, when the calendar refuses it. The calendar of ridrs on this device stays immediate.
5. **Reads have a validity per resource**, each with its own time (`fetched` in the cache file):

   | Resource | Requests | Valid for |
   |---|---|---|
   | athlete and today's wellness weight | 2 | 1 hour |
   | planned events and the rides done | 2 | 15 minutes |
   | library (workouts and folders) | 2 | 24 hours, read only when it is shown |

   A start with a valid cache sends nothing. A stale cache is shown at once and read again in the background (stale-while-revalidate). A saved ride reads the events resource only. The refresh button reads the athlete and the events at most once a minute (the plugin ignores a second call, the button rests). The library is read through the new service `training.library.load` (keyed like `training.refresh`), which the Training area calls when it shows the library; a valid library answers without a request. There are no timers and no reload on window focus. A cache from before (no `fetched`) is stale in every resource; the file stays readable by the old code (`fetchedAt` remains).

   The brief counted five reads; the plugin also read the done rides (`GET …/activities`), so the events resource costs two requests (events and activities), and a start is 4 requests, a library 2.
6. **One gateway.** Every request to intervals.icu (reads, writes, the upload, the token exchange, the disconnect) goes through one function in the plugin (`gateway.ts`): at most 5 requests a second (staggered, so the parallel reads of a load no longer burst), writes wider (250 ms), and writes in the same queue as the loads. On HTTP 429 it honours `Retry-After` (seconds or a date; a minute without one), sends nothing until that time has passed, and never retries by itself. The account becomes `failed` with the new reason `rate-limited` (the contract's reason list grows by one value; the texts are in the English and German files of `ui-training-plan`); the shown data stays as the last copy, and the Connect button is not offered, as the token is fine.
7. **Measurement.** The gateway counts requests per local day and 15-minute window by purpose (`athlete`, `events`, `history`, `library`, `profile-write`, `calendar-write`, `upload`, `auth`) and logs each one with its window count and the day's total. The simulated intervals.icu counts requests per method and path so scenarios assert budgets.

**Budget.** A typical day under 30 requests, the worst case under 100.

## Consequences

- New: `DataSource.remote`, the account reason `rate-limited`, the service `training.library.load`, the module `gateway.ts` of the plugin. Registered in `apps/native/src/compose.ts`, `apps/headless/src/main.ts` and the test World.
- The Me page needs an explicit Save for a remote source; a rider used to the immediate steppers now clicks once more. The local provider is unchanged.
- The pacing is wall-clock pacing of I/O through `setTimeout`, not simulation time; it does not touch rides (ADR 0068, rule 13). The scenarios set the pacing to zero; a unit test covers the real values.
- Planned workouts shown in watts are derived with the FTP of the time they were read; an FTP read an hour later does not recompute workouts that are valid for 15 minutes. Accepted.
- Done rides appear after the next events read (at most 15 minutes, or at once after a saved ride or a refresh).

## Implementation

- **S1** `gateway.ts` (counter by purpose, logged per request), the simulated intervals.icu counts requests per method and path, no-op guards in `writeProfile` and `writeCalendar`.
- **S2** `DataSource.remote`; the Me area's draft, Save, Discard and Back (`ui-area-me`).
- **S3** per-resource reads with `fetched` in the cache, stale-while-revalidate, the service `training.library.load` (called by the Training area), the refresh cooldown (plugin and button), a saved ride reads the events resource only.
- **S4** (replaced) the draft list of the Training week was dropped again: plans and moves go out at once (`ui-area-training`, `tests/features/ui/calendar-immediate.feature`).
- **S5** the gateway: pacing 5 a second, writes 250 ms, one queue, `Retry-After`, the reason `rate-limited`.

Scenarios: `tests/features/training/request-budget.feature`, `tests/features/ui/athlete-profile-draft.feature`, `tests/features/ui/calendar-immediate.feature`; the scenarios of `athlete-profile-to-intervals-icu`, `plan-from-library`, `workout-library` and the offline ones were changed to press Save, to show the library when asked for, and to let the cache go stale before an offline start (their intent is the same). Vitest: `plugins/planner-intervals-icu/gateway.test.ts`.

The gateway paces with the wall clock (`Date.now()`) and `setTimeout`: the logical clock stands still inside a turn.
