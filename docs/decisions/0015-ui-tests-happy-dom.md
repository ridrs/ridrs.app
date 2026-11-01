<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0015: UI Scenarios in a Headless DOM (happy-dom)

UI scenarios run the **real host, in-process bridge, shell and UI plugins** in Node, rendered into **happy-dom** 21.0.4 (MIT), registered globally through `@happy-dom/global-registrator` 21.0.4 (MIT). Assertions use **`@testing-library/dom`** 10.4.2 (MIT): its `findBy*` / `waitFor` retry until React has rendered, so there are no hand-written polling loops or sleeps.

Why not Playwright, as the brief proposed: with D2 the GUI runs inside the Tauri WebView, and Tauri's WebDriver does not cover all target platforms (handover §7). The composition logic is the same in the WebView and in Node, because the shell is plain DOM code and the core is runtime-neutral, so a headless DOM exercises exactly that code, inside `pnpm test`, without a browser download.

Consequences:

- React keeps module-level references to the DOM globals, so happy-dom is registered once per run. `@ui` scenarios therefore run in a Cucumber profile of their own (`--profile ui`, second half of `pnpm test:bdd`), separate from Node-only scenarios.
- happy-dom has no layout engine. The layering scenario asserts the declared stacking (absolute layers in one stacking context, z-order, `pointer-events`) instead of hit-testing. The real hit test (`elementFromPoint` on widget, landscape and **Finish ride**) is part of the manual check of `apps/native`.
