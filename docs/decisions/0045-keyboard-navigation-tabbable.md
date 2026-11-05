<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0045: Arrow-Key Navigation with `tabbable`

## Context

AGENTS.md rule 12 asks that every UI is usable with the arrow keys, Enter and Back alone. Moving the focus with the arrows needs the focusable elements of a screen in reading order: which elements can take the focus (buttons, links, fields, `tabindex`, not disabled, not inert, not hidden) is generic DOM knowledge, not ridrs domain logic (AGENTS.md rule 2).

## Decision

- **tabbable** 6.5.0 (MIT, ESM, no dependencies; the focus engine of `focus-trap`) in `@ridrs/ui-shell`: `tabbable(root)` gives the elements in Tab order, and the shell's `keyboardNavigation` moves the focus one step along them per arrow key, stopping at the ends.
- The order is linear (reading order), not spatial: the screens are columns and short rows of controls, where up/down and left/right mean the same step. A spatial navigation library (geometry-based, like TV platforms) would only pay off with grids, and it needs layout, which the headless DOM of the UI scenarios does not have.
- Enter is not handled: the browser activates the focused button or link and submits forms itself.
- Back is a stack in the shell (`UiContext.onBack`), not a library: the screen decides what Back means.

## Consequences

- One small library instead of an own focusable-element query, which is easy to get subtly wrong (disabled fieldsets, `inert`, `<details>`, radio groups).
- In happy-dom, tabbable cannot see what CSS hides (no layout); screens remove elements instead of hiding them, so the scenarios see what the rider sees.
- A spatial order can replace the linear one later without changing screens: they only register Back handlers.
- The shell remembers the place of the focused element among the tabbable ones: when it disappears, the next arrow goes on from that place on the same screen instead of the first element, and a focused element outside the order steps to its neighbours in document order (`compareDocumentPosition`).
