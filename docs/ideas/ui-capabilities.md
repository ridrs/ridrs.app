<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Proposal: UI Capabilities With Typed Input – Where Else They Help

**Status: proposal, 2026-11-11. The mechanism itself (`ctx.render(capability, container, input)`) was accepted by the maintainer for the workout chart of [structured-workouts.md](structured-workouts.md); this document looks at the other UI plugins.** Looked at: every UI plugin in `plugins/ui-*`, `packages/ui-shell`, `packages/contracts/src/{activity,route,training}.ts`.

## Why a New Mechanism

A UI plugin has screens and contributions. A host opens a slot, and the shell mounts every contribution of that extension point into it (`ctx.slot('hud/widget', container)`, `packages/ui-shell/src/shell.ts`). A component gets a container and its context, **no input**: it fetches its data itself through `ctx.state.watch(...)`. That fits the HUD: the power widget knows it shows power, and the host only offers room.

A workout chart is the other way round: only the **host** knows what to draw. The week shows twelve charts at once, each of another workout; a library card shows one workout of intervals.icu; the editor shows an unsaved draft that changes with every key; and the chart reports back which step was focused. The obvious ways around this each break something:

| Way around | Problem |
|---|---|
| Write the workout to the app state, the chart reads it | The app state holds app data, not view parameters (rule 13); twelve charts would need twelve keys; a draft per key stroke through the state is misuse |
| Put the data on the container as `data-*` | Untyped, unchecked: a hidden contract beside the DOM |
| Import the chart from the plugin | Forbidden (rule 5); dependency-cruiser fails the build |
| A package with a React component that everyone imports | Works, but is no plugin: not replaceable, not optional, not declared in a manifest |
| `ctx.slot(point, element, { input })` | A slot mounts **every** contribution of its point: two plugins contributing a chart would draw two charts. "Draw this" needs exactly one provider. |

## The Mechanism (Accepted)

A host capability such as `storage.app-files` is a contract one plugin fulfils and others call with data. A **UI capability** is the same for interfaces: a component with typed input, provided by exactly one plugin.

```ts
// contracts
export const workoutChart = defineUiCapability('ui.workout-chart', {
  input: z.object({ workout: workoutSchema, variant: z.enum(['micro', 'mini', 'full', 'edit', 'hud']) /* … */ }),
  output: { 'step-focused': z.object({ stepId: z.string() }) },   // plain data only
});
```

```jsonc
// provider manifest
"ui": { "provides": [{ "capability": "ui.workout-chart", "export": "WorkoutChart" }] }
// consumer manifest
"ui": { "uses": ["ui.workout-chart"] }
```

```ts
// provider
export const WorkoutChart: UiCapabilityComponent<typeof workoutChart> = (container, ctx, input, emit) => {
  draw(container, input);
  return { update: (next) => draw(container, next), release: () => container.replaceChildren() };
};

// consumer
const chart = ctx.render(workoutChart, element, { workout, variant: 'mini' });
chart.on('step-focused', ({ stepId }) => select(stepId));
chart.update({ workout: draft, variant: 'edit' });
chart.release();
```

What the shell does, after the patterns it already has for slots and services:
- **Checks:** a plugin that has not declared the capability gets `undeclared-capability` (like `undeclared-service`); the input is checked by Zod before it reaches the provider.
- **Exactly one provider:** two providers of the same UI capability are an error at start, like a `single` host capability.
- **Optional (ADR 0053):** without the provider, or while it is stopped, `ctx.render` returns a handle with `available: false`, and the consumer shows its fallback (e.g. "65 min · TSS 72"). Once the plugin starts, the shell mounts it, as it does for slots today.
- **Lifetime:** handles belong to the calling component and are released with it, like slots.
- **Plain data only:** input and output are JSON-like, no callbacks, no React elements; the mechanism stays framework neutral.

## 1. Starting a Ride?

**Not for the choice itself, but for the preview of the choice.**

- The world, the video and the workout of a **running ride** belong on the bus, never into render input: they decide what the ride *is*, and a replay must restore them from the recording (rule 13: a value the app and a ride both use enters the ride as input; rule 10: rendering reads, it never drives). ridrs does this right today: `activity.start-requested` carries `{ world }`, `activity.state-changed` carries `world` on, and the landscape `ui-world-video` reads its route from there. If the activity screen handed the route to the landscape through `ctx.render`, a replay would lose it.
- The **choice before the start** (which route, which workout, which bicycle) is app state: a draft until the start event makes it part of the ride. That is not render input either.
- What the start **gains** is the **preview**: the briefing shows the elevation profile of the chosen route and the chart of the chosen workout one above the other, and later their combination (route fusion). Those are exactly two UI capabilities.

## 2. Which Mechanism When (Rule of Thumb for the ADR and Reviews)

| Question | Mechanism |
|---|---|
| The **host decides *what*** is shown, **exactly one plugin** knows *how*, and **several plugins** show it | **UI capability** (`ctx.render`) |
| The host offers **room**, any number of plugins decide *what* they show there | **Slot** (`ctx.slot`) |
| The value decides a **ride** (route, workout, targets, gear) | **Bus** (event, input), recorded |
| The value is **app data** (catalogue, profile, calendar, a draft) | **State and services** |
| A general **control** without domain knowledge (date picker, toggle, list) | A **package** (`@ridrs/ui-sdk`) or the shell, no plugin |

## 3. Candidates

Rule 3 still holds: a capability is made only once a use case of the current phase needs it. The list says *when*, not *all now*.

### 3.1 `ui.workout-chart` – accepted

As in [structured-workouts.md](structured-workouts.md). Used by Today, cards, calendar, details, editor, briefing and the HUD of the player; later by the debriefing (planned against done).

### 3.2 `ui.route-profile` – strongly recommended, next

**Today:** the elevation profile (a hill under a line, gradient colours, summit labels, climb categories, a glowing dot) lives in `plugins/ui-area-ride/client/profile.tsx` and `index.tsx`, about 400 lines, used only inside `ui-area-ride`: cards, details, the Today tile "Ride again".

**Who else needs it:**

| Where | Today | With the capability |
|---|---|---|
| Search (`ui-search`) | the text "32 km · 840 m" of a placeholder list | a small profile in the result |
| Briefing | does not exist yet | the profile of the chosen route above the workout chart |
| Debriefing (`ui-debriefing`) | no profile | the profile with the ridden distance |
| Events (`ui-area-events`) | no profile | the profile of the event's route |
| HUD | a gradient widget only | a profile widget with the position and the next climb (`progressMeters`) |

```ts
defineUiCapability('ui.route-profile', {
  input: z.object({
    route: z.string(),                      // offer id or world route
    variant: z.enum(['micro', 'card', 'full', 'hud']),
    progressMeters: z.number().optional(),  // HUD and debriefing: where the rider is or was
  }),
});
```

The provider fetches the elevations itself from `route.offer` and `spatial-terrain`; the host only says *which* route. Otherwise every consumer would have to know about elevations.

**Gain:** the profile becomes its own plugin, `ui-area-ride` gets smaller, and the workout chart and the route profile share their variants and their look. Due with the briefing (phase 6 of the workout plan) or once the search shows real routes.

### 3.3 `ui.ride-chart` – recommended with the player or a richer debriefing

**Today:** the debriefing (`ui-debriefing`, 344 lines) shows numbers, no course over time.
**Later:** power, heart rate and cadence over time, optionally over the workout as background (planned against done) and the ghost.
**Used by:** the debriefing, the details of a done calendar entry, the ride history, the ghost comparison.
**Input:** `{ sessionId, series: ['power', 'hr', 'cadence'], overlay?: { workoutId } }`; the provider reads the data from the recording.
It can reuse the chart geometry of `@ridrs/workout`, but stays its own capability: its input differs.

### 3.4 `ui.route-card` – possible, medium priority

**Today:** the route card (the picture fills the card, the profile behind it, title, numbers, download badge, Download and Cancel) exists only in `ui-area-ride`; the Today tile "Ride again" has its own variant in the same plugin.
**Who would need it:** the search, events ("the route of this event"), suggestions on Today, the briefing.
**Trade-off:** a card has **actions** (download, ride), so it needs the output events of the capability (`emit('go')`, `emit('download')`) to leave the host in charge of what follows. The accepted design allows that. Whether the profile (3.2) is enough and each host builds its own plain card is decided once the search gets real routes.

### 3.5 `ui.workout-card` – not needed

A workout card is a title, a few numbers and `ui.workout-chart` (`mini`): so little that every host can build it; the complexity is in the chart. If needed, a shared card style (`pv-card`) in the shell.

### 3.6 `ui.avatar` – later, when the avatar comes

The avatar would appear in the HUD, the profile, the garage, events and leader boards. The host only says *who* (`riderId`, `size`); the avatar plugin knows how they look. A model case for a UI capability, and today nothing yet (rule 3).

## 4. What Should **Not** Become a UI Capability

| Area | Today | Why it stays |
|---|---|---|
| **Landscape** `activity/landscape` | a slot with `{ contribution: world.landscape }`; the landscape reads its route from `activity.state-changed` | Ride data belongs on the bus, or the replay breaks (section 1). The slot with `contribution` is right here: the world *chooses* the landscape. |
| **HUD widgets** `hud/widget`, `hud/erg-on`, `hud/erg-off` | slots | Many widgets, each knows what it shows; the layout comes from the configuration (ADR 0058) |
| **Today tiles** `main/tile`, **menu** `menu/item`, **connections** `me/connection`, **pairing** | slots | Classic extension points: offering room, the plugins decide |
| **Search** `ui-search` | the placeholder catalogue `CATALOGUE` | The missing piece is the **data source**, not the drawing: the areas do not offer their content yet. Needed: a search data type or service that route, workout and event providers fill. The results then *draw* with 3.1 and 3.2. |
| **Date pickers, lists, toggles** | in plugins | General controls belong in `@ridrs/ui-sdk` or a package, not in a plugin |
| **Formatting numbers** `metric-display` | a package in `ui-sdk` | A pure function without a domain plugin: right as a package |

## 5. Starting a Ride With a Workout

The briefing is decided (structured-workouts.md, section 11): every ride starts through it, and it asks only for what the button that led to it has not fixed.

```
Briefing (screen, keyboard and controller required)
 ├─ choose route or world ───────> preview: ctx.render(ui.route-profile, { route, variant: 'full' })
 ├─ choose workout (optional) ───> preview: ctx.render(ui.workout-chart, { workout, variant: 'full' })
 ├─ choose bicycle (garage)
 └─ Go ──> bus: activity.start-requested { world, workout }   ← input of the ride, recorded
                 │
                 ├─ activity-session: the state carries world and workout on
                 ├─ workout-player: sets trainer.target-power as input
                 ├─ landscape: reads the route from the state (as today)
                 └─ HUD: ctx.render(ui.workout-chart, { workout, variant: 'hud', progressSeconds })
                          ← progressSeconds comes from the bus; the HUD only passes it on
```

In the HUD the widget *reads* the workout and the progress from the bus and hands them to the capability. That is allowed, since rendering reads and drives nothing; the capability itself knows nothing of rides and is the same as on Today.

**What this adds:**
- `activity.start-requested` and the activity state get an optional `workout`. For a replay without the catalogue, the **whole workout** goes there, not an id.
- A draft `ride.briefing` (app state) holds the choice until Go, so it survives a visit to the garage.

## 6. Recommendation and Order

| # | Capability | When | Effort |
|---|---|---|---|
| 1 | `ui.workout-chart` | workout plan, phase 2 | planned |
| 2 | `ui.route-profile` | with the briefing (workout plan, phase 6) or once the search shows real routes | medium: the code exists; moved and aligned |
| 3 | `ui.ride-chart` | with a richer debriefing or planned against done | medium |
| 4 | `ui.route-card` | once the search shows real routes; check first whether 2 is enough | small |
| 5 | `ui.avatar` | when the avatar comes | – |

**For the ADR of the UI capability:** take in the rule of thumb of section 2 and the limits of section 4, above all: *ride data is never render input; it is read from the bus and at most passed on.* That keeps anyone from moving the landscape to `ctx.render` later and breaking the replay.
