<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0098: The Debriefing in a Dialog over the Ride

Status: accepted on 2026-11-16 by the maintainer ("baue den Debriefing-UI-Screen so dass er in einem Dialog modal über dem Aktivitätsscreen erscheint. Man soll das Debriefing auch abbrechen und zur Aktivität zurückkehren können. Außerdem soll vom Debriefing aus die Einstellungen und die Geräte erreichbar sein."). Amends [ADR 0064](0064-ride-debriefing-and-activity-upload.md) (when the ride ends) and applies [ADR 0071](0071-global-screens-in-a-dialog-over-the-page.md) to the activity screen.

## Context

Finish ride ended the ride at once (`activity.finish-requested`) and the activity screen gave way to the debriefing as a screen of its own. A ride that is finished cannot go on (ADR 0056: `idle -> running <-> paused -> finished`), so a Finish ride pressed by mistake could only be saved or deleted. The settings and the devices were out of reach until the ride was decided.

## Decisions

- **Finish ride asks first.** With the debriefing there (`ctx.hasScreen`), Finish ride pauses a running ride (`activity.pause-requested`) and opens the debriefing; without it, it ends the ride as before.
- **The debriefing opens in a dialog over the ride.** The activity screen opens an outlet with a dialog (`OutletOptions.dialog`, ADR 0071) for `debriefing`, `settings` and `setup`. It draws the dialog like the main screen does (backdrop, panel, a full-screen sheet below 600 px); the ride beneath is `inert` and hidden from assistive technology, so the arrows stay in the dialog (AGENTS.md rule 12).
- **Save and Delete end the ride.** The debriefing publishes `activity.finish-requested` (new in its manifest) when the rider presses Save or confirms Delete; the upload or the deletion then follows as before, keyed by the ride's session, which the debriefing knows from the running or paused state already.
- **Continue ride goes back.** While the ride is not ended the debriefing offers Continue ride, and Back does the same: the dialog closes and a ride that ran before Finish ride goes on (`activity.resume-requested`); one that was paused stays paused. Once the ride is ended, Back keeps offering Save, as before: no ride is left undecided.
- **Settings and Devices from the debriefing.** The debriefing offers Devices (`setup`) and Settings when those screens are there. They open in the same dialog; leaving them leads back to the debriefing, not to the ride. The activity screen decides this from `onNavigated` and knows the screens by id only (rule 5).
- **An ended ride stays in its debriefing.** Should the dialog close over a finished ride, the activity screen opens the debriefing again. The debriefing gets no Close button; the settings and the devices do.
- **The debriefing of a link** (ADR 0079) is unchanged: a ride that is already finished, shown on its own from the main screen, without Continue ride.

## Consequences

- The distance and the time appear only once the ride is ended (they come from the written recording): while the rider decides, the ride is paused, not finished.
- The ride's end time is when Save or Delete is pressed, after a pause from Finish ride; the paused time is not ridden time.
- The activity screen registers its outlet and its state subscription at commit (`useLayoutEffect`): Finish ride can be pressed before passive effects ran.
- Tests: `debriefing.feature` (dialog, Continue ride, Back, a paused ride, Settings and Devices and back, Back over an ended ride); `pause-a-ride.feature`, `done-workouts.feature` and `activity-link.feature` unchanged.
