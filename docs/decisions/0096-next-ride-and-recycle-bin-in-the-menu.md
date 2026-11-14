<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0096: The Next Ride and the Recycle Bin in the Main Menu

Status: accepted on 2026-11-13.

## Context

The rider wants to prepare the next ride wherever they find its parts: a workout in the Training area, a route on the Ride page. Until now a workout or a route was ridden at once (Ride, Go) or through the briefing's choice; nothing kept "this one next" across a restart.

Removing things was a bar at the bottom of the Training area that appeared while a planned workout or a ride done was dragged, and deleted it at the provider on the drop (`DELETE` at intervals.icu). A slip could not be taken back.

The main menu sits beside every page but the ride, so both belong there: the next ride under the entries, the bin at the bottom.

## Decision

- **Two new extension points of the main menu:** `menu/section` below the entries and `menu/footer` at the bottom of the menu. The menu does not know what fills them (AGENTS.md rule 5).
- **Drags between plugins carry typed data** (`packages/contracts/src/drag.ts`): `application/x-ridrs-workout+json`, `application/x-ridrs-route+json` and `application/x-ridrs-removable+json`, each with a zod schema. The menu and the pages are separate React roots, so nothing but `dataTransfer` crosses between them. WebKit shows only the types during `dragover`, so a drop target decides by the type, and reads and checks the payload on `drop`. The sources keep `text/plain` and their local drag state.
- **`ui-next-ride`** owns the app state **`ride.next`** (key `next`): a workout (one of a library, or a planned entry) and a route (its offer id and world), each with the name shown when it is gone. It is written through **`ride.next-set`** and kept as the user document `next-ride`, so it survives a restart. Its menu section takes a workout and a route by drag and drop, with × to take one out. **Start next ride** opens the briefing with both as fixed points (`ride.briefing` key `fixed`); it does not skip the briefing, which resolves the workout with the athlete profile, fetches a route and shows the devices. A ride that **finishes** with everything the next ride holds (the same workout, the same route) clears it; an interrupted ride does not, a different ride does not.
- **`ui-recycle-bin`** owns the app state **`trash.item`**, keyed by `keyOfRemovable` (`calendar-entry:<provider>:<id>`, `done-ride:<provider>:<id>`), kept as the user document `recycle-bin`. A drop deletes nothing: **`trash.put`** moves the item into the bin, and every view of the calendar and the rides done hides what is there (`isBinned`, `withoutBinned`). **`trash.restore`** gives it back. **`trash.purge`** deletes it for good through the contract services `training.calendar.remove` and `training.history.remove` (for a ride done, at every provider that has it) and answers which items failed and why; a failed item stays. The bin is an entry of `menu/footer` with a count, a drop target while something it takes is dragged, and the way to its page (`trash`, in the content area): Restore and Delete permanently per item, Empty bin, each deletion confirmed first.
- **The bin takes what the old bar took:** planned workouts of any calendar, and rides done. Library workouts and routes are not taken yet (rule 3); `removableSchema` is a discriminated union, so a kind can be added.
- **The calendar of ridrs on this device** (ADR 0059) keeps a binned entry in its document until it is purged. Its provider, the host side of `ui-area-training`, now removes an entry on `training.calendar.remove` from the document and publishes the calendar again; the area's client reads its document again when an entry of ridrs leaves the bin (`userDocument(...).reload`).
- The floating bar of the Training area is removed.

## Consequences

- The scenarios of `calendar-remove.feature`, `done-workouts.feature` and `app-area-changes.feature` that removed or deleted on the drop now drop into the menu's bin and delete in the bin; this changes given scenarios on purpose, as the maintainer asked (2026-11-13).
- A binned planned workout is not handed over to Today and is not offered by the briefing or the next workout tile; it is still in the provider's calendar until it is purged, so another app sees it.
- On the narrow menu (medium) the next ride is one tile that takes both kinds; on the compact bottom bar it is not shown, and the bin is a bar entry.
- The bin is not on the ride path (rule 12): its page needs a pointer for the drops, but its buttons work with the keyboard. "Start next ride" is a button in the menu's order.
