<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Presentation and Render Clock (Phase 7)

The GUI renders at the display's frame rate while the physics runs at 100 Hz. Rendering reads interpolated physics states and never drives or writes the simulation. Decisions: ADR 0028.

## Three time worlds

```text
event time        sensors → temporal data layer                     (irregular)
simulation time   physics-engine, fixed 10 ms steps                 (100 Hz, owns the truth)
render time       shell frame clock, one loop at display refresh    (≈60 FPS, reads only)
```

```text
physics-engine ──(every step)── RideSimulation
   │  physics.state        (step 0, every 25 steps, at finish – HUD text, headless consumers)
   │  physics.state-batch  (every 5 steps = 50 ms, each step exactly once)
   ▼
in-process UI bridge (allow-list from UI manifests)
   ▼
UI plugin (ui-landscape-flat) ── createPhysicsPresentation(ctx.events)   ← @ridrs/presentation
   │                               history (2 s) · at(frame time) · linear interpolation
   │ ctx.frames.onFrame(frame ⇒ presentation.at(frame.time))
   ▼
ui-shell FrameClock ── one loop on requestAnimationFrame, frame.time = bridge.now()
```

## Batches (`physics-engine`)

`physics.state-batch` carries `{ sessionId, samples }`, 1–5 consecutive `PhysicsSample`s (`step`, `at`, `speed`, `distance`, `acceleration`, `gradient`), copied from the step's `PhysicsState`.

- At ride start: `[0]`, right after step 0's `physics.state`.
- At every step that is a multiple of 5 (`ENGINE_DEFAULTS.batchEverySteps`): the steps since the previous batch (`[1…5]`, `[6…10]`, …).
- At finish: the remaining steps, if any (`[101, 102]`).
- Catch-up after a late wake publishes the same batches in the same order; boundaries depend only on step indices.
- A `physics.state` at a multiple of 25 goes out before the batch that contains its step. A failed step discards unbatched steps and publishes nothing further.

## History and the state at a render time (`@ridrs/presentation`)

`PRESENTATION_DEFAULTS`: render delay **60 ms**, history **2000 ms** relative to the newest sample (a sample exactly 2000 ms older is kept). Samples are kept per session; a new session clears them. A batch that does not continue the newest step is a gap, which is never interpolated across. Repeated samples are ignored.

`at(frameTime)` evaluates `renderTime = frameTime − 60 ms`. With `a` the newest sample at or before `renderTime` and `b` the one after it:

| Situation | Result |
|---|---|
| No sample, or `renderTime` before the oldest kept sample | `none` |
| `renderTime` exactly at a sample | that sample, `exact` |
| `a`, `b` consecutive steps | `speed`, `distance`, `acceleration` interpolated with `f = (renderTime − a.at) / (b.at − a.at)`; `step`, `gradient` from `a`; `interpolated` |
| `renderTime` after the newest sample | the newest sample, `held` |
| A gap between `a` and `b` | `a`, `held` |

No extrapolation. Results are frozen; `at()` never changes the history. `stats()` counts calls by basis (`frames`, `exact`, `interpolated`, `held`, `none`).

## Frame clock (`ui-shell`)

- One `FrameClock` per app, created by the shell and nowhere else. Its `FrameSource` runs only while a handler is subscribed: the main screen without the landscape renders no frames.
- Each frame reads `bridge.now()` once and calls every handler in subscription order with the same frozen `UiFrame { index, time }`.
- A throwing handler is reported once through `reportClientError` with its plugin id (`client-load-failure`). It stays subscribed; other handlers and later frames are unaffected.
- `ctx.frames.onFrame` subscriptions are released when the component unmounts, like events and slots.
- Sources: `requestAnimationFrame` in the shell (paused while the WebView is hidden); `startRidrsApp({ frameSource })` for tests; `timerFrameSource(fps)` from `@ridrs/presentation`, which schedules frame `k` at `round(k · 1000 / fps)` ms after it starts, on fake or real timers.

## No feedback

- The presentation exposes no publish, no capability and no way to reach the physics. The engine knows nothing about frames.
- The only path from the GUI to the core stays user input through declared `ui.events.publish` events. A repository test checks that no UI manifest publishes a `physics.*` event.
- `render-clock.feature` checks that 0, 30, 60 and 144 FPS produce the same speed and distance.

## Writing a frame-driven UI plugin

1. Declare `physics.state-batch` in `ui.events.subscribe` and depend on `@ridrs/presentation`.
2. On mount, create one presentation with `createPhysicsPresentation(ctx.events)`.
3. Subscribe `ctx.frames.onFrame((frame) => draw(presentation.at(frame.time)))`. Touch the DOM directly (refs) rather than re-rendering React on every frame.
4. Draw only what the presented state says. Do not smooth, predict or integrate.
5. On unmount, dispose the presentation; the shell releases the frame subscription.

`ui-landscape-flat` is the reference: it moves its centre-line dashes by `distance mod 8 m` and exposes `data-distance` (two decimals, empty for `none`) and `data-basis` on its SVG. At ride finish it logs `presentation.stats()` through the UI logger.

## Tests

- `presentation/interpolation.feature`: the presentation alone, fed batches by hand.
- `presentation/state-stream.feature`: the real host's batches (every step once, catch-up, finish, samples equal states).
- `presentation/render-clock.feature`: the real host, the in-process bridge with `ui-landscape-flat` discovered, and a presentation client on a `FrameClock` with `timerFrameSource` on fake timers.
- `apps/ride-with-moving-road.feature` (`@ui`, real timers): `startRidrsApp` with the `simulated-trainer` fixture and a 60 FPS timer source.
- Vitest: interpolation, session reset, gaps, trimming at exactly 2000 ms, frozen results, stats, the frame clock (start/stop, order, a throwing handler), the timer source, batching across catch-up chunks, and the manifest and frame-clock ownership tests.
