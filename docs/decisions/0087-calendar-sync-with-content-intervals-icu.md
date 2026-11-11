<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0087: Planned Workouts Go to intervals.icu With Their Content

Status: accepted on 2026-11-11 ([structured-workouts.md](../ideas/structured-workouts.md), section 10; F6, A6). **The representation sent is pending the maintainer's manual check against the real API** (see "Open").

## Context

A built-in or own ridrs workout planned in the intervals.icu calendar arrived there with its name and length only. intervals.icu holds a workout either as text in the event's `description` (its workout syntax, from which it builds the `workout_doc` itself) or as a `workout_doc` sent directly; which of the two it keeps without loss is not documented, and a forum report says only the description works.

## Decision

- `training.calendar.plan` of a workout of another provider takes its content from that provider's `training.library` entry (`workout`, else `steps`) and creates the intervals.icu event **with its content**: watts as `200w`, zones as `Z2`, ramps as `ramp`, cadence as `rpm`. Workouts of the intervals.icu library keep going with their original `workout_doc`; nothing is rewritten.
- **Representation:** a switch `contentSync.send` in `planner-intervals-icu`: `description` (the default and working choice: intervals.icu text after the rider's description, written by `exportIntervalsText`) or `workout_doc` (`exportIntervalsDoc`). Both exporters live in `@ridrs/workout` (`codecs/export/`), with warnings for what intervals.icu cannot express.
- **The link** of an entry to its library workout is kept on this device, in the planner's cache, by event id: `{ from, workoutId, date, mode, content hash, source hash }`. A marker in the description would show in the rider's text on every device and could be edited or copied away.
- **Edits follow:** when a linked library workout changes, its entries dated today or later that were not ridden are updated by `PUT` with the new content, without a question, after one fresh read of the plan (request budget, ADR 0078). Past and ridden entries stay.
- **Changed in intervals.icu:** when the content hash of an entry no longer matches on a read, it keeps what intervals.icu has and loses its link: ridrs never silently overwrites a change made there.
- The whole `workout_doc` is read into the canonical model; what it lacks is kept in `extensions.intervals.doc`, and reading and exporting it again gives the same document.
- Zones are read from and written to the Ride sport settings (ADR 0082), in the same `PUT` as the FTP.

## Open

The maintainer checks by hand (dates in 2030, deleted afterwards): one event with the text in `description` only, one with `workout_doc` only; then `GET` each and compare:
1. Is a `workout_doc` sent on POST/PUT kept as the structure, or ignored or rebuilt?
2. Does the description path keep ranges vs. ramps, `Z2` and `Z2 HR`, watts, `rpm`, `freeride`, `maxeffort` and the lap button?
3. Do name, description and `workout_doc.steps` come back unchanged on a later GET (the content hash depends on it); are a ramp's `start`/`end` kept in order?
4. Does a `PUT …/events/{id}` with new content replace the structure?
If the description path loses something the doc path keeps, the default switches to `workout_doc`.

## Consequences

- Links are per device: another device of the rider does not follow this device's links.
- A change made in intervals.icu between ridrs' fresh read and its `PUT` can still be overwritten (a window of one request).
- Entries planned from the intervals.icu library are loose copies there, as intervals.icu does it, and are not linked.
