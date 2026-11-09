<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0076: Done Workouts from Every Provider

Status: **accepted** on 2026-11-09 by the maintainer, on their request for the Training area ("workouts (geplante und durchgeführte) sollen gezeigt werden", answered: "eine Zusammenführung aller Provider und lokaler Daten inklusive Duplikatserkennung"). Builds on [ADR 0075](0075-data-sources-for-the-athlete-profile-and-the-training-plan.md).

## Context

The Training area's calendar shows the planned workouts of the chosen source (ADR 0075). The rider also wants to see what they did: the rides recorded on this device and the activities of every connected service. ADR 0075 has one chosen source per data type, and the library is read from all providers at once; nothing there says how rides that two providers both know are shown once.

## Decision

- **A fourth data type, `training.history`**, defined with `defineDataType` like the others: topic keyed by the provider, value `{ workouts: CompletedWorkout[] }` with `id`, `date` (the rider's local date), `startedAt`, `name`, `sport`, `durationSeconds?`, `trainingLoad?` and `externalId?`. Read only; it has no writes.
- **No choice, like the library:** every provider adds to what the area shows. A ride is one that was done, so there is no source of truth to choose; the rider has nothing to configure.
- **Merged by the reader, not stored.** The Training area merges the providers' entries when it renders; nothing is copied between providers (ADR 0075 still holds for the data types with a source).
- **Duplicate rule.** Two entries are the same ride when they share an `externalId` (a ride of ridrs that was uploaded to intervals.icu has the session id as `external_id`), or, without one, when their sports match and their start times are less than five minutes apart. The merged entry takes the richer fields: the name and training load of the service, the id of the session.
- **Providers.** `planner-intervals-icu` offers the activities of the last 14 days (`GET /api/v1/athlete/0/activities`, scope `ACTIVITY:READ`). `history-ridrs` offers the rides saved on this device, read from the sealed `.ridrs` recordings.
