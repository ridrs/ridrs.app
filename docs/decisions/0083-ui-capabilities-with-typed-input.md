<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0083: UI Capabilities With Typed Input (`ctx.render`)

Status: accepted on 2026-11-11 by the maintainer ([ui-capabilities.md](../ideas/ui-capabilities.md); [structured-workouts.md](../ideas/structured-workouts.md), section 5, F2).

## Context

A slot (`ctx.slot`) mounts every contribution of an extension point into a container, without data: the host offers room and the plugins decide what they show. A workout chart is the other way round: only the host knows which workout to draw (twelve in a week, an unsaved draft in the editor), and the chart reports back which step was focused. Writing view parameters to the app state, `data-*` attributes, importing another plugin's component or a shared React package each break a rule (13, 5) or the plugin model.

## Decision

- A **UI capability** is a component with typed input, provided by **exactly one** UI plugin. It is defined in the contracts with `defineUiCapability(id, { input, output })`: the id starts with `ui.`, the input is a zod schema, the output is a map of event names to zod schemas.
- **Manifest:** the provider declares `ui.provides: [{ capability, export }]`, a consumer `ui.uses: [capability]`.
- **Use:** `ctx.render(capability, container, input)` returns a handle with `available`, `update(input)`, `on(event, handler)` and `release()`. The provider's export is `(container, ctx, input, emit) => { update, release }`.
- **The shell checks:** an undeclared capability throws `undeclared-capability`; the input is parsed before it reaches the provider and the output before a consumer sees it; two providers of one capability are an error at start, like a `single` host capability.
- **Optional** (ADR 0053): without the provider, or while it is stopped, the handle has `available: false` and the consumer shows its own fallback; once the provider starts, the shell mounts it, as for slots.
- **Lifetime:** handles belong to the calling component and are released with it.
- **Plain data only:** input and output are JSON-like; no callbacks, no framework elements.

**Which mechanism when** (the rule of thumb for reviews):

| Question | Mechanism |
|---|---|
| The host decides *what* is shown, exactly one plugin knows *how*, several plugins show it | UI capability (`ctx.render`) |
| The host offers room, any number of plugins decide what they show there | Slot (`ctx.slot`) |
| The value decides a ride (route, workout, targets, gear) | Bus (event, input), recorded |
| The value is app data (catalogue, profile, calendar, a draft) | State and services |
| A general control without domain knowledge | A package (`@ridrs/ui-sdk`) or the shell |

**Ride data is never render input.** It is read from the bus and at most passed on, as the HUD passes the progress of the workout to the chart. The landscape, the HUD widgets, the Today tiles, the menu and the pairing stay slots: making the landscape a UI capability would lose the route on replay.

## Consequences

- The first capability is `ui.workout-chart` (input: the workout, the athlete's FTP, LTHR, maximum heart rate and zones, the variant `micro`, `mini`, `full`, `edit` or `hud`, the progress and the selected step; output: `step-focused`). The next is `ui.route-profile`, with the briefing.
- New capabilities follow rule 3: one is made only when a use case of the current phase needs it.
