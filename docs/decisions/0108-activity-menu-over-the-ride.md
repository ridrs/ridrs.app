<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0108: Activity Menu over the Ride and Two-Step Finish

Status: accepted on 2026-11-24. Amends [ADR 0098](0098-debriefing-in-a-dialog-over-the-ride.md) and [ADR 0064](0064-ride-debriefing-and-activity-upload.md).

## Context

Under ADR 0098, pressing **Finish ride** on the activity screen paused the ride and opened `debriefing` directly as "Ride finished" with **Save**, **Delete** and **Continue ride** side by side. That had three UX flaws:

1. **No in-ride menu.** Opening the dialog to check devices or settings immediately greeted the rider with "Ride finished" and destructive/terminal buttons (**Save**, **Delete**) before the ride was actually finished, and because the ride was only paused, its recorded distance and time could not be shown yet.
2. **No way to load or switch a workout or route during a ride.** Once a ride started, its `workout` and `world` were fixed until the end: a rider who started a free ride could not load a workout mid-ride, switch to another workout, stop just the structured workout to ride on freely, or switch to another route without ending the session.
3. **Weak visual hierarchy between Save, Delete and the Delete confirmation.** **Save** and **Delete** shared the same button size in one row, and the delete confirmation used verbose labels instead of a direct "Are you sure?" with **Yes** / **No**.

## Decisions

- **Menu button on the activity screen.** When the `debriefing` screen is registered (`ctx.hasScreen('debriefing')`), `ui-activity-screen` shows **Menu** (`menu.svg`, `data-testid="activity-menu"`) in the bottom-right corner in place of **Finish ride**; pressing **Back** on the activity screen focuses **Menu** so **Enter** opens it without ending anything by accident. Without `ui-debriefing` (minimal/headless screen compositions), **Finish ride** stays as the fallback that publishes `activity.finish-requested` directly.
- **Two-phase dialog in `ui-debriefing`: Activity menu first, Ride finished second.**
  1. **Activity menu (`Ride menu` / `Aktivitätsmenü`)** while the ride is `running` or `paused`:
     - Opening **Menu** pauses a running ride (`activity.pause-requested`); a ride already paused stays paused.
     - **Primary ride actions:** **Continue ride** (`Weiterfahren`, primary button, focused when the menu opens; **Back** does the same) closes the dialog and resumes a ride that **Menu** paused, while **Finish ride** (`Fahrt beenden`) publishes `activity.finish-requested` and transitions the dialog into the **Ride finished** phase.
     - **Workout (`Load workout` / `Change workout`):** shows the active workout's name or **No workout** (`Kein Workout`). Opening the inline picker lists **No workout** (ending an active structured workout while riding on), planned calendar workouts from today on, and library workouts (excluding binned entries). Choosing a workout resolves its targets against the ride's athlete profile (`resolveWorkout`; refusing with a clear message when FTP or power zones are missing) and publishes `activity.workout-requested`.
     - **Route (`Change route` / `Strecke wechseln`):** shows the current route's title or **Free ride** (`Freie Fahrt`). Opening the inline picker lists **Free ride** and downloaded (`ready`) route offers; un-downloaded offers are shown disabled as not on this device. Choosing a route publishes `activity.world-requested`.
     - **Devices (`setup`) and Settings (`settings`):** remain reachable from the menu footer in the same modal dialog and return to the Activity menu on **Back** or **Close**.
  2. **Ride finished (`Fahrt beendet`)** once **Finish ride** ended the ride (or when opened for a finished ride via `ridrs://activity` link):
     - Because the ride is now `finished`, the recording seals immediately in the background and **Distance** and **Time** appear right in the dialog.
     - **Save** (`Speichern`) is rendered as a **large primary call-to-action button** (focused automatically).
     - **Delete** (`Löschen`) is rendered as a **small, quiet secondary danger button** visually separated from **Save**.
     - Pressing **Delete** asks **"Are you sure?"** (`Bist du sicher?`) with simple **Yes** (`Ja`) and **No** (`Nein`) buttons (**No** focused first and **Back** also cancelling back to **Save**).
- **Mid-ride workout and route changes on the simulation bus (AGENTS.md rules 7 & 13).**
  - Two simulation input events in `@ridrs/contracts`: `activity.workout-requested` (`{ workout?: RideWorkout }`) and `activity.world-requested` (`{ world?: RideWorld }`).
  - `activity-session` accepts both while `running` or `paused` (reporting `invalid-transition` when `idle` or `finished`), updates `workout` or `world` on the current session's `ActivityState`, and publishes `activity.state-changed` with the same `sessionId` and `startedAt`.
  - `workout-player`, `control-erg`, `ui-widget-workout`, and `ui-hud-gauges` (`WorkoutTargetTracker`) detect workout changes within an ongoing session: loading or switching a workout starts the new workout from step 1 at 100 % intensity (holding while paused, ticking once running), and clearing the workout stops the player and leaves ERG (`trainer.target-power` `null`).
  - `physics-engine` and `physics-virtual-speed` key session initialization by `sessionId` so mid-ride `activity.state-changed` updates never reset an ongoing physics run.
  - `ui-world-video` (`WorldPublisher`), `ui-landscape-demo` (`TerrainPublisher`), `world-driver-ui`, and `ui-hud-gauges` (`RouteBoxView`, `CurrentSegmentView`) anchor a newly entered route at the ride's current odometer (`startDistance`): the new route's video, GPX track, elevation profile and climbs start from `0 m` of that route while publishing `world.terrain-preview` and `world.position` at the session's continuous odometer so physics, FIT export and deterministic replay stay seamless.
  - `history-ridrs` picks the latest workout ridden in the session when naming a saved ride.

## Consequences

- Every mid-ride workout or route switch is a recorded bus input; `ridrs-headless recording replay` reproduces the exact states, targets and terrain windows without catalogue access.
- Distance and duration are visible again in **Ride finished** before **Save** or **Delete** is pressed.
- Usable end-to-end with arrow keys, **Enter** and **Back** alone (AGENTS.md rule 12).
