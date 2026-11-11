<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0080: Keyboard and Controller on the Ride Path; Pointer Allowed on the Workbench

Status: accepted on 2026-11-11 by the maintainer ([structured-workouts.md](../ideas/structured-workouts.md), sections 2 and 14, F10).

## Context

AGENTS.md rule 12 asked every user interface to be fully usable with the arrow keys, Enter and Back alone. That fits everything a rider does on the trainer, where hands are on the handlebar and a controller (Zwift Ride, a remote) is all there is. It does not fit a workout editor that drags interval edges, the drag and drop of the training calendar, or a file import: there a rider sits at a desk, and forcing controller use would make these screens worse for everyone without helping anyone on the bicycle.

## Decision

Rule 12 is reworded (AGENTS.md, word for word as in the plan, section 2):

- **Ride path: keyboard and controller required.** Everything a rider does once they sit on the trainer: pairing devices, the briefing (choosing the route or world, the workout and the bicycle), starting, riding, pausing, continuing an interrupted ride, finishing, the debriefing and saving or uploading. Also browsing and filtering the workout catalogue, the workout details with stepping through a chart, and Today's "Next workout" tile.
- **Workbench: pointer or touch is enough.** Creating and editing workouts, editing the training plan and the calendar, importing and exporting files, the athlete profile and its zones, the avatar, the settings. These screens keep the standard keyboard behaviour of their controls but need not be usable by controller alone.
- Borderline cases decided by the maintainer: pairing devices is ride path; the settings are workbench.
- Nothing is taken back: screens that are fully usable by keyboard today stay so.
- Scenarios of ride-path screens prove the use with arrows, Enter and Back alone; workbench scenarios may use the pointer.

## Consequences

- Reviews ask for each new screen which side it is on; the table in the plan is the reference.
- The workout editor (phase 4) and the import (phase 3) may be pointer first; the details, the catalogue filters, the briefing and the HUD widget may not.
