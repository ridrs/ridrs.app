<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0064: Ride Debriefing and Activity Upload

## Context

A finished ride went straight back to the main screen; its recording and FIT file stayed on the device. Riders who plan on intervals.icu ([ADR 0048](0048-intervals-icu-connection-and-training-plan.md)) want the ride there too, without exporting it by hand. Not every ride is worth keeping, so the rider decides first.

## Decision

- **A debriefing after every finished ride.** `ui-activity-screen` navigates on `activity.state-changed` `finished` to the screen `debriefing` when it is there (`ctx.hasScreen`, new in `UiContext`: whether a screen of a plugin that may be absent exists), else to `main` as before. The screen belongs to the plugin `ui-debriefing`; the activity screen only knows its id.
- **The debriefing** shows "Ride finished", distance and time (`recording.completed`) and whether Save uploads ("as Alex Rider") or keeps the ride on this device. The rider closes it with:
  - **Save.** With intervals.icu connected, it publishes `training.upload-requested { sessionId, file }` once the FIT file is written (`export.fit-written`), shows "Uploading to intervals.icu…" and goes to `main` when `training.upload-changed` says `uploaded`. On `failed` it stays, says why and that the ride is kept on this device, and offers Try again, Save without upload and Delete; after `token-rejected` (or `not-connected`) it offers Reconnect (`training.connect-requested`), and Try again waits for the account. Without an account, Save goes to `main` at once; that needs no recording, so a ride without a recorder never holds the rider.
  - **Delete**, after a confirmation (Delete ride or Keep ride): `recording.delete-requested { sessionId, file }`, then `main`.
  - **Since ADR 0068/0069 and 2026-11-07:** the events are the app state `recording.ride`, `export.fit`, `training.upload` and the services `training.upload`, `training.connect`, `recording.delete`. The recording and its FIT file are written in the background and the rider never sees it: Save and Delete can be pressed at once (no "Saving the ride…"). Save shows "Uploading to intervals.icu…" and the upload starts as soon as the FIT file is there, at once if it already is; a confirmed Delete removes the ride once its recording is written. `debriefing.feature`: "Save works at once and uploads as soon as the FIT file is there". Open: if the FIT export fails, the upload waits on (the export only reports `fit-export-failed`).
  - **Back** never decides: it closes the confirmation and focuses Save (AGENTS.md rule 12).
- **Deleting.** `recording-session` removes only a completed recording of that session (`recordings/…-<session>.ridrs`) and publishes `recording.deleted { sessionId }`; `export-fit` removes the FIT file, also one still being written. The ride-saved panel of `ui-tile-ride-start` disappears for a deleted ride.
- **Uploading.** `planner-intervals-icu` posts the FIT file as `multipart/form-data` (field `file`, encoded by the platform's `FormData`) to `POST /api/v1/athlete/0/activities?external_id=<sessionId>`; 200 and 201 are `uploaded`. intervals.icu recognises a file it already has by its hash, so trying again creates no second activity. 401 or 403 forget the token like a load does (`account-changed` → `failed`, `token-rejected`). Results enter through `ctx.inputs`. `net.http` takes bytes as a body (`Uint8Array`) besides text.
- **Scope `ACTIVITY:WRITE`.** The sign-in asks for `SETTINGS:READ,CALENDAR:READ,ACTIVITY:WRITE`. Tokens from before lack it: their first upload gets 403, and the rider reconnects from the debriefing.

## Consequences

- Every rider sees the debriefing after a ride, also without an account; Save is one extra press.
- Events: `recording.delete-requested`, `recording.deleted`, `training.upload-requested`, `training.upload-changed { service, sessionId, state: uploading | uploaded | failed, reason?: not-connected | token-rejected | unreachable | rejected }`.
- `debriefing.feature` covers the screen against the simulated intervals.icu; the app scenarios save through it.
