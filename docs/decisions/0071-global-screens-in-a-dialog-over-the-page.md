<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0071: Global Screens in a Dialog over the Page

Status: accepted on 2026-11-08 by the maintainer ("remove Me and Garage from the left and put a garage icon next to me on the top bar; all pages from the top should not change the general navigation, but open a dialog on top of the current page") and implemented the same day. Amends [ADR 0058](0058-main-screen-layout-by-configuration.md) (the layout names dialog screens), [ADR 0059](0059-app-areas-as-a-clickable-preview.md) (Me leaves the menu) and [ADR 0060](0060-equipment-garage-and-the-frozen-bicycle.md) (the garage is a global action, not a menu entry).

## Context

The menu offered Today, Ride, Training, Events, Me and Garage; the top bar offered Search, Devices, Settings and Profile. Every one of them replaced the page in the content area: opening Settings from Ride left Ride, and Back from Settings went to Today, not back to Ride. Me was reachable twice (menu entry and Profile). The menu should be about where the rider is going (the areas), the top bar about things the rider looks at in passing.

## Decisions

- **The menu holds the areas only:** Today, Ride, Training, Events. `ui-area-me` and `ui-garage` no longer contribute to `menu/item`.
- **The top bar holds the global actions:** Search, Devices, Settings, Garage, Profile. `ui-garage` contributes `garage` to `main/action` (Lucide's `warehouse` icon), placed before the profile so the profile stays at the end.
- **A global screen opens in a dialog over the page.** `layout.json` names those screens in `dialogs` (`search`, `setup`, `settings`, `garage`, `me`), apart from `screens` (the areas, shown in the content area). A screen may be in only one of the two lists.
- **The shell keeps the page beneath the dialog.** `OutletOptions.dialog` (`@ridrs/ui-sdk`) gives the outlet a second container and the screens it shows. Navigating to one of them mounts it there and keeps the page (Today or the area in the outlet) mounted and unchanged. Navigating to any other screen closes the dialog first. Elsewhere (no outlet with a dialog) the screen is shown on its own, as before.
- **`ctx.leave()` leaves the shown screen**, as Back does by default: a screen in a dialog closes and the page comes back; any other screen gives way to the first screen (Today), as `useBack` did before. `useBack` and the device setup (Back, Continue, Done) use it, so a screen does not need to know whether it is in a dialog.
- **`onNavigated(handler(screen, page))`.** The second argument is the page beneath a dialog (else the shown screen). Menu entries and the main screen follow the page, so Ride stays marked and framed while Settings is open over it; global actions follow the shown screen.
- **The main screen draws the dialog.** It has a backdrop, a panel with Close, and a full-screen sheet at the compact width. While it is open the menu and the column beneath it are `inert`, so the arrows stay in the dialog (AGENTS.md rule 12). The panel takes the focus when the dialog opens and gives it back to where it was when the dialog closes. Back, Close and a click on the backdrop leave the screen.

## Consequences

- Opening a global screen never changes where the rider is. Back after Settings over Ride lands on Ride.
- The screens do not know that they are in a dialog; the layout decides it (rule 5 holds: the main screen still names no screen in its code).
- In a dialog the arrows first reach Close, then the screen's controls (`keyboard-navigation.feature`, `garage.feature`).
- Tests: `app-areas.feature`, `garage.feature`, `main-screen-layout.feature`, `keyboard-navigation.feature`, `app-area-changes.feature`, and the unit tests of the layout.
