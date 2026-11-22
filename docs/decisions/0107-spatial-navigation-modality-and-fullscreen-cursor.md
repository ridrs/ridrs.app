<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0107: 2D Spatial Navigation, Automatic Input Modality, Unified Highlight and Fullscreen Cursor Auto-Hide

Extends ADR 0045 (arrow-key navigation with `tabbable`) and ADR 0098 (controller buttons as keys).

## Context

After several iterations on arrow-key and controller usability (AGENTS.md rule 12), four concrete defects remained:

1. **Inconsistent focus rings across controls (e.g. two of the four round activity buttons had a border while the other two did not).** `Pause` and `Finish ride` relied on CSS `:focus-visible`, while `ERG` (`ui-widget-target-power`) and `Screenshot` (`ui-ride-screenshot`) tracked React `onFocus`/`onBlur` state with inline `outline`. Because controller presses dispatch synthetic `KeyboardEvent`s (ADR 0098) and screens call `.focus()` programmatically, WebKit's `:focus-visible` heuristic stayed false on `Pause` and `Finish ride`, whereas `ERG` and `Screenshot` drew inline outlines even after mouse clicks and lacked hover styles altogether.
2. **No input modality tracking and fragmented hover vs. focus styles.** Moving the mouse left stale focus rings while hovering another control (highlighting two elements at once); plugins each declared ad-hoc `:hover` and `:focus-visible` rules with differing offsets and filters.
3. **1D linear arrow order.** ADR 0045 mapped `ArrowDown`/`ArrowRight` identically to "next" and `ArrowUp`/`ArrowLeft` to "previous". On grids (route cards, dashboard tiles), sidebars beside content, and the activity screen (HUD controls above bottom-right controls), vertical and horizontal arrows did not match visual geometry.
4. **Fragile recovery when controls appear, disappear or disable, and visible mouse cursor in fullscreen.** Tracking only a snapshot index on `focusin` broke when siblings were inserted/removed before the focused element, when the focused button became `disabled` (staying connected in the DOM), or when a dialog made the background `inert`. In fullscreen, the mouse pointer stayed visible indefinitely over the ride.

## Decision

All four concerns live in `@ridrs/ui-shell` so every screen and plugin behaves identically without cross-plugin coupling:

- **2D spatial navigation over live `tabbable` (`spatial-nav.ts`, `keyboard.ts`).** Keep `tabbable` 6.5.0 for live focusable discovery (no shadow registration that can go out of sync with dynamic plugins). Whenever elements have real layout rectangles (`width > 0 && height > 0`), arrow keys pick the closest candidate in the pressed direction (`up`, `down`, `left`, `right`) using a W3C CSS Spatial Navigation Level 1 distance metric (corridor overlap strongly favoured, orthogonal gap weighted 3×, deterministic reading-order tie-break, stop at screen edges). In headless DOMs without layout (`happy-dom`), navigation falls back seamlessly to reading order.
- **Resilient dynamic anchor (`keyboard.ts`).** A `MutationObserver` and capture `scroll` listener keep the focused element's reading-order index and bounding rectangle fresh as siblings appear or disappear. When the focused element is removed, disabled or hidden (while its screen stays shown and non-inert), focus is never auto-moved onto a neighbouring control (preserving safety against accidental activation of destructive actions like Remove); the next arrow recovers spatially from the vanished element's saved rectangle (or falls back to the nearest remaining control / index without layout).
- **Automatic input modality (`input-modality.ts`).** `document.documentElement.dataset.inputMode` switches automatically between `"keyboard"` (any navigation/activation key — trusted or synthetic — or `ridrs:controller-button`) and `"pointer"` (pointer/touch press or genuine pointer displacement ≥ 4 px, ignoring zero-movement phantom `mousemove`s triggered by scroll or layout shifts).
- **Single unified highlight style (`interaction-style.ts`).** `mountShell` installs one ref-counted stylesheet using `--ridrs-focus-ring` (3 px cyan, 2 px offset). In `keyboard` mode only `:focus` highlights (no `:hover`); in `pointer` mode (while the cursor is visible) only `:hover` highlights with the exact same ring (no stale `:focus` on buttons; text inputs keep a focus ring while actively focused for typing). Custom composite controls (`.pv-teaser-open`, `.we-format` hidden radios, `.wi-file`, `.wc [data-step]`) delegate via `data-highlight="delegate"`. Plugin-local inline `outline` hacks and divergent `:hover`/`:focus-visible` rules are removed.
- **Fullscreen cursor auto-hide (`fullscreen-cursor.ts`, `apps/native/src/platform.ts`).** In fullscreen, the pointer hides after 2.5 s without real movement — and immediately upon keyboard/controller input — via `data-cursor-hidden` (`cursor: none !important`, which also suppresses `:hover` highlights under the hidden pointer) and, on desktop Tauri, `Window.isFullscreen()` / `Window.setCursorVisible()` (macOS native fullscreen does not set `document.fullscreenElement` and WebKit does not refresh CSS `cursor: none` while the pointer is stationary). The cursor is always restored on real movement, window blur, leaving fullscreen, or teardown.

## Consequences

- Every interactive control — including all four round buttons on the activity screen — shares one consistent highlight for both focus and hover, and at most one control is highlighted at a time.
- No extra runtime dependency is needed beyond `tabbable`: pure geometry over live DOM rects avoids registration libraries that drift when plugins mount/unmount buttons.
- `apps/native/src-tauri/capabilities/default.json` grants `core:window:allow-is-fullscreen` and `core:window:allow-set-cursor-visible`.
