<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0088: The Months of the Large Calendar

Status: **proposed** on 2026-11-11, so that the large calendar of the Training area shows the data of the month it shows. It amends [ADR 0078](0078-drafts-for-external-data-sources-and-request-budget.md) (one more kind of read with its validity) and [ADR 0076](0076-done-workouts-from-every-provider.md) (the rides of more than the last 14 days), and refers to [ADR 0075](0075-data-sources-for-the-athlete-profile-and-the-training-plan.md) (the calendar as a data type). Number 0087 was taken (calendar sync with content) while this was written.

## Context

The large calendar of the Training area shows whole months, Monday first: up to six weeks a page. `planner-intervals-icu` reads the planned workouts of today and the next 13 days and the rides of the last 14 days, so most days of a month stayed empty, past plans were never shown, and a month ahead showed nothing. A workout planned or moved beyond the next 14 days vanished from the calendar shown, because the plugin dropped what was outside its window.

Two ways were weighed:

- **A wider default window** (for example two months each way at every read). Every start, refresh and saved ride would read far more than the next workout card and the week need, and a rider paging three months ahead would still see nothing. The window grows the data, never the request count, but it is a guess about where the rider looks.
- **Reading the days shown, on demand.** The page that shows the days asks for them. Only months the rider pages to cost anything, and the start stays as it is.

## Decision

1. **A service `training.range.load`** (`@ridrs/contracts`, `trainingRangeLoadService`), keyed by the account like `training.refresh` and `training.library.load`: `{ key, oldest, newest }`, the rider's local dates, at most `TRAINING_RANGE_MAX_DAYS` (42) days, `oldest` not after `newest`. It answers once the work started; the data follows in the provider's `training.calendar` and `training.history`. Read-only, no new data type and no new state.
2. **The large calendar asks for the weeks it shows.** `MonthCalendar` (`plugins/ui-area-training/client/week.tsx`) calls `useShownDays` (`client/shown-days.ts`) with the first and the last day of its grid each time the month changes. It asks every provider of `training.calendar` or `training.history` with `remote: true`; the providers on this device hold every day already and are not asked. The week view is unchanged: its weeks lie in the default window or show the ridrs calendar.
3. **`planner-intervals-icu` reads a span with two requests**, `GET …/events?oldest&newest&category=WORKOUT` and `GET …/activities?oldest&newest`, through the gateway (purposes `events` and `history`), in the same one-at-a-time work as the other reads; spans asked for during other work are read right after it, together. A span asked for again while it is read is not read twice.
4. **Validity.** A span is valid for 15 minutes, like the plan (ADR 0078, item 5): asked for again within that time and inside a span read, it costs no request. A stale span is shown from what is held and read again. There are no timers: nothing is read for a month the rider does not page to.
5. **What is held.** The plugin keeps the spans read (`spans` in the cache file, each `{ oldest, newest, at }`; a cache from before has none). A read replaces the days it covers and keeps the others; a day is kept while the default window (plans: today and 13 days; rides: 13 days and today) or one of the latest 12 spans holds it, so the cache stays small however far the rider pages. A plan, move or removal and the mailbox's events (ADR 0079) keep their workout where a span holds its day, so a workout moved into a later month stays in it. Offline, the spans held are shown like the rest of the cache.
6. **The calendar may begin before today.** `training.calendar` keeps its date order, but can hold past days. Its readers that want the next workout take the first from today: the next workout card of `ui-training-plan` does.

**Budget.** Opening the large calendar costs 2 requests, and each further month paged to 2 more; paging back within 15 minutes costs none. A rider who looks at three months a day adds about 6 requests to the typical day of ADR 0078 (under 30), and the worst case stays under 100.

## Consequences

- New: `training.range.load` (registered in `apps/native/src/compose.ts`, `apps/headless/src/main.ts` and the test World), `TRAINING_RANGE_MAX_DAYS`, `range.ts` of `planner-intervals-icu` (the spans, their validity and the merge of days), `useShownDays` of `ui-area-training`.
- The calendar and the history of intervals.icu hold more than 14 days; the cache file grows by up to 12 months of workouts and rides.
- The first month of the large calendar is read when it is opened, not at start: for a moment its past plans and its later weeks are empty.

## Implementation

Scenarios: `tests/features/training/calendar-months.feature` (paging shows each month's plans and rides; a month costs two requests for the weeks it shows; a month read in the last 15 minutes costs nothing, a stale one is read again; a workout moved into a later month stays there; the next workout is still the next one from today; the months read are shown offline). Vitest: `plugins/planner-intervals-icu/range.test.ts`.
