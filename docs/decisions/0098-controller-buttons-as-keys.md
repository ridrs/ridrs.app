<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0098: Controller Buttons as Keys, with Bindings in the Settings

Status: accepted on 2026-11-16, for the controller tab of the settings (`controller-bindings.feature`); the maintainer asked for bindings shown as games show them, with sensible defaults for the Zwift Ride.

## Context

AGENTS.md rule 12 promises a ride path usable with the arrow keys, Enter and Back, "or the controller buttons mapped to them". Until now no one mapped them: `controller.buttons-changed` reached virtual gears (shift buttons) and ERG (power-up buttons) only. A rider on the trainer had to reach for the keyboard to start a ride.

## Decision

- **Commands, not keys, are bound.** `@ridrs/contracts` names six commands (`up`, `down`, `left`, `right`, `confirm`, `back`) and the buttons they may go on: the d-pad and A, B, Y, Z. Shift, power-up and on/off buttons keep their ride functions and cannot be bound, so a binding can never shift a gear or change the ERG target by surprise. The defaults: d-pad → arrows, A → Enter, B → Back.
- **No command is ever without a button.** Every command has exactly one button, no two share one (the schema refuses it). Putting a command on a button another command had swaps the two, as games do; the settings say so.
- **App state, not the bus** (rule 13). `ui-settings` owns `controller.bindings` (one key, `controller`) and keeps it in its user document `controller.json`; `controller.set-bindings` replaces all bindings at once. Bindings change the UI, never a ride, so they are not recorded.
- **The shell turns buttons into keys.** `mountShell` watches `controller.bindings` (defaults while no one owns it) and subscribes to `controller.buttons-changed` whenever the registry allows it. Each new press dispatches the cancelable DOM event `ridrs:controller-button` (`CONTROLLER_BUTTON_EVENT` of `@ridrs/ui-sdk`) on the document; unless a component took it, it dispatches `keydown` of the bound key on the focused element, and for Enter, when no one handled the key, clicks the focused button, link or tab, as a browser does. Arrows repeat while held (400 ms, then every 120 ms). The buttons held when the shell subscribes are no presses.
- **The settings have tabs:** General, Controller, About. The controller tab lists the commands with their buttons; choosing one waits for the next button pressed on the controller (taking it through `ridrs:controller-button`), Back cancels the waiting. The fixed ride buttons are listed below it. Held buttons light up, so the rider sees the controller work.

## Consequences

- Every screen that works with the keys works with the controller, with no change to any screen.
- A controller other than the Zwift Ride uses the same commands as long as its device plugin publishes buttons of the contract; bindings per controller model are a later step.
- Shifting and power-up stay fixed; making them bindable would move their meaning out of the simulation plugins and needs its own decision.
