<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0028: Presentation and Render Clock

## Context

Phase 7: "The GUI runs at 60 FPS while the physics runs at 100 Hz." Until now the HUD shows `physics.state` at 4 Hz, which is too coarse for anything that moves, and the landscape animated its lane markings with a loop of its own that integrated the 4 Hz speed. That loop was a second, unrecorded physics. Rendering must be smooth without ever slowing, driving or changing the simulation.

## Decision

- **Three time worlds that never clock each other.** Event time (sensors → temporal data layer, irregular), simulation time (`physics-engine`, fixed 10 ms steps, owns the truth) and render time (the shell's frame clock at the display's refresh rate, reads only). The physics never waits for, reads from or is driven by the GUI. The GUI never writes into the physics. 0, 30, 60 or 144 FPS give identical physics states.
- **Every step, in batches of five.** Besides the unchanged `physics.state`, the engine publishes `physics.state-batch`: `{ sessionId, samples }` with 1–5 consecutive `PhysicsSample`s (`step`, `at`, `speed`, `distance`, `acceleration`, `gradient`), copied from the states. Step 0 goes out at ride start, then every multiple of 5 with the steps since the previous batch, plus the rest at finish. Boundaries depend only on step indices, never on wake timing: a catch-up chunk of 1000 steps publishes the same batches. A `physics.state` at a multiple of 25 goes out before its batch. A failed step discards what is not yet batched. 100 single events per second would be wasteful, and the 4 Hz state is too coarse to interpolate.
- **The history lives on the UI side.** `@ridrs/presentation` keeps the samples of one session, the last 2000 ms relative to the newest sample. It is fed through the consuming plugin's own `ctx.events` (the plugin declares `physics.state-batch`), so it works through the existing allow-listed bridge, and a remote UI would work the same way. A new session clears the history. A batch that does not continue the newest step is a gap: the bridge replays only the latest envelope, so a plugin may first see a batch mid-ride. One presentation per consuming plugin is acceptable while there is one consumer; a shared UI-side service is a later option.
- **A render delay of 60 ms.** A frame at `t` shows the physics at `t − 60 ms`: one batch (50 ms) plus one step, so the two neighbouring samples have normally arrived.
- **Interpolation, not extrapolation.** Speed, distance and acceleration are interpolated linearly between two consecutive samples; step and gradient come from the older one (discrete values are never blended). Exactly at a sample: `exact`. After the newest sample (late batch, finished or failed ride) or at a gap: the older sample, `held`. Before the oldest: `none`. Results are frozen; `stats()` counts calls by basis for the manual check. Low-latency extrapolation is a later option.
- **One frame clock, in the shell.** `ui-shell` owns one `FrameClock` per app on a `FrameSource` port: `requestAnimationFrame` in the WebView (paused while hidden), `timerFrameSource(fps)` on (fake or real) timers in tests, through `startRidrsApp({ frameSource })`. It runs only while a handler is subscribed, reads `bridge.now()` (the host clock, so render time is on the simulation's axis) once per frame and calls every handler in subscription order with the same frozen `UiFrame`. A throwing handler is reported once via `reportClientError` and stays subscribed. Subscriptions through `ctx.frames.onFrame` belong to the component's mount.
- **No new dependency.** Linear interpolation and a bounded array are domain code. `requestAnimationFrame` is a platform API behind the port. No animation, tweening, game-loop or state-management library.
- **License: AGPL-3.0-or-later** (maintainer decision 2026-11-02). The brief proposed Apache-2.0 as an SDK package. The interpolation of simulation state is platform logic under LICENSING.md, so `@ridrs/presentation` is AGPL like the official UI plugins that use it.
- **No Web Worker yet.** The physics costs microseconds per step, and the frame clock reads only the UI-side history, so a busy main thread delays frames, not the simulation's results (a late wake catches up deterministically). The manual check records frame drops and held-frame share on a desktop and a phone; that evidence decides about a worker later.

## Enforcement

- dependency-cruiser: `@ridrs/presentation` imports only contracts and ui-sdk types (no core, DOM framework, rxjs or Node builtins; unresolvable imports are errors). Physics plugins, core, contracts and temporal never import UI or presentation packages. UI plugins cannot import core, physics plugins or temporal (existing rules).
- Repository tests: no UI manifest lists a `physics.*` event in `ui.events.publish`; no plugin constructs a `FrameClock`. The core still knows no concrete event names.
- `render-clock.feature` proves FPS independence for 0, 30, 60 and 144 FPS.

## Consequences

- The landscape's road markings move every frame by the presented distance (`distance mod 8 m`); the landscape smooths, predicts and integrates nothing itself. The HUD numbers stay on `physics.state` at 4 Hz.
- What is shown is 60 ms behind the simulation, and the first 60 ms of a ride show nothing. Neither is noticeable on a backdrop.
- `UiBridge.now()` is exact only in-process. A remote UI needs clock synchronisation before it can use the presentation (not in Phase 7).
