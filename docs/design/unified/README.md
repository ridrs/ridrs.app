<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# One design language for ridrs (2026-11-15)

Builds on [`../assessment/`](../assessment/README.md). The five mockups in `../concepts/` were not used.
This is implemented in the real code, on the branch `docs/design-concepts` (merged up to `main` 901fc6d, which brought the route box).

**The rule.** The language of the **route cards** (Ride) and of the **route box** (ride HUD, top right) is the language of the whole app: the navy gradient card with a light edge, 12 px corners, small tracked mono labels, tabular numbers, volt for the action and for progress, cyan for information and for the focus.

## 1. The tokens

All tokens live in **one place**: `TOKENS` in `plugins/ui-main-screen/client/kinetic.tsx`. The main screen's own style (`ui-main-screen/client/index.tsx`) and the Kinetic layer both take the same string, so the older token set (blue/lime, 16 px radius) is gone. About 275 hex fallbacks (`var(--ridrs-x, #...)`, three different values per token) were removed from all plugins and packages; the tokens now always come from the one set.

| Role | Token | Value | Derived from |
|---|---|---|---|
| Page | `--ridrs-bg` | `#07090e` | Kinetic (kept) |
| Card (the surface) | `--ridrs-card` | `radial-gradient(120% 90% at 85% 0%, #2a4a78, transparent 60%), linear-gradient(160deg, #1b2d4d, #0d1626)` | route card, route box |
| Quiet card (lists, tiles, tools) | `--ridrs-card-quiet` | `linear-gradient(160deg, #15233b, #0d1626)` | same hue, no glow |
| Flat panel / raised | `--ridrs-surface`, `--ridrs-surface-raised` | `#0e1523`, `#17233a` | |
| Edge | `--ridrs-edge` | `inset 0 0 0 1px rgb(255 255 255 / .12)` | the `::after` edge of route cards, route box |
| Elevation | `--ridrs-shadow` | `0 10px 28px rgb(0 0 0 / .38)` | route box |
| Line (dividers) | `--ridrs-line` | `rgb(255 255 255 / .14)` (was 1.37:1, now visible) | |
| Text / muted | `--ridrs-text`, `--ridrs-text-muted` | `#f1f5f9`, `#9aa9c0` | |
| Action, progress, done | `--ridrs-accent` | `#ccff00` (volt) | |
| Information, label, **focus** | `--ridrs-info`, `--ridrs-focus` | `#00f0ff` | |
| States | `--ridrs-ok`, `--ridrs-warn`, `--ridrs-danger` | `#3ddc84`, `#ffb62e`, `#ff5a6e` (danger was undefined before) | |
| Radii | `--ridrs-radius-sm / -radius / -radius-lg / -radius-pill` | 8 / 12 / 16 px / 999 | cards 12, route box and dialogs 16 |
| Type | `--ridrs-font-text`, `-display`, `-mono` | Plus Jakarta Sans, Chakra Petch italic caps (headlines), JetBrains Mono | route cards |
| Sizes | `--ridrs-size-label / small / body / title / value / hero` | 11 / 13 / 15 / 19 / 28 / 40 px | replaces 23 sizes |
| Fonts in the page | | `body` has the text face; there is **no body-wide `!important` any more**, so inline and class fonts (mono labels, the display face of "Paused") win. Controls inherit it through `:where(button, input, select, textarea)` | |
| Weights | | 500 text, 600 display (only what is loaded) | `font-weight: 600/700/800/900` (they rendered as 500) all set to 500 |
| Label | `.ridrs-label` / `[data-label]` (plus the old label class names, see `LABEL_ONLY` in `kinetic.tsx`) | JetBrains Mono 11 px, .12 em, capitals, cyan; the same on the next-ride head, briefing section heads, debriefing figures, HUD labels, route box | route card classifier, route box "GRADIENT" |
| Numbers | | tabular figures on every `[data-testid="value"]` | route box |
| Focus | `--ridrs-focus-ring` | `3px solid var(--ridrs-focus)`, offset 2 px, one rule for all (the seven old styles are gone) | |
| Motion | `--ridrs-ease` | .15 s | |

**Component rules (applied everywhere):** a surface is a card (gradient, light edge, no 1 px border); a button is a 12 px raised surface with the edge, the primary is volt; a chip is a pill and its **selected** state is a filled white pill; **cyan means focus (and information text) only**: the current page is a raised fill with a volt icon (no ring), ERG on is a volt label on the same card as Pause and Finish, a busy badge is volt text, and every "drop here" state is volt; the one dashed shape is a place to drop something onto.

## 2. What was kept of the angular language

**Nothing is chamfered any more** (`clip-path: polygon` is gone from the repository: menu, next ride, calendar, month view). I kept two non-angular brand motifs instead, and use them everywhere: **italic Chakra Petch capitals for headlines and menu labels** (as on the route cards) and the **volt/cyan colour roles**. Volt is no longer a fill of every done entry or of the current menu entry; it marks the action (Start, Continue, Save), progress (route box, calendar done bar and check) and the current page's icon and label.

## 3. Per screen

| Screen | Before / after | Changed |
|---|---|---|
| Today | `before/01-today.jpg` / `after/01-today.jpg` | hero tile and tiles are cards; recovery prompt `after/44-ride-recovery.jpg` is a card with a warn edge and the same buttons |
| Main menu | `before/60-focus.jpg` / `after/60-focus-and-armed-bin.jpg` | current entry: card surface with edge and volt icon/label, **no clip-path**, so the cyan focus ring is whole (it was clipped and 1.2:1); footer separated by a line instead of `margin-top: -16px` |
| Next ride | see `01-today` | filled slot is a card (like route cards), empty slot the one dashed shape, no stripes, ring, top strip, glow or pulse |
| Trash | `before/61-bin-armed.jpg` / `after/61-focus-nextride-bin-over.jpg` | same horizontal entry as the others, count a pill at its end (token-based), armed = danger edge, over = danger tint, hint is a card above the entry (not wine, not floating over the page) |
| Ride | `02-ride` | tokens only (cards already were the target); selected chips filled white |
| Training | `before/05-training.jpg` / `after/05-training.jpg` | calendar grid is a 16 px card; every entry is the same small card with a 4 px kind bar (planned cyan, done volt + volt check, outdoor green, rest/note grey), today is a volt top bar without glow; New/Import buttons side by side instead of stretched; library cards (`05b`) |
| Devices dialog | `before/20-dialog-devices.jpg` / `after/20-dialog-devices.jpg` | cards with the edge, volt "Continue" is the primary button (was a huge ghost button with lime chevrons), one-colour headline, old cyan/lime/red palette replaced by tokens, spinner and focus unified |
| Garage, profile, settings, search | `21`-`24` | dialog frame 16 px with edge and shadow (was 20 px), tokens, chips |
| Briefing | `before/30-briefing.jpg` / `after/30-briefing.jpg` | cards and buttons via the shared tokens, focus ring on Start unchanged and visible |
| Ride HUD | `before/40-ride-hud.jpg` / `after/40-ride-hud.jpg` | all HUD elements (gauges, ride facts, route box, gear, ratio, target power, workout, debug panel) draw with the same card, edge and label tokens; route box progress uses the token volt (`#ccff00`, was the old `#b8f53b`); Pause, ERG and Finish are cards with the shared focus ring |
| Pause | `before/41-ride-paused.jpg` / `after/41-ride-paused.jpg` | "Paused" is a card with display type (it was white text on the video, unreadable on bright scenes) |
| Debriefing | `before/42,43` / `after/42,43` | distance and time are cards with mono labels and tabular figures, buttons as everywhere, Save is volt |

## 4. Files changed

Tokens and layer: `plugins/ui-main-screen/client/kinetic.tsx` (exports `TOKENS`, focus ring, selected chips, labels), `plugins/ui-main-screen/client/index.tsx`.
Shared look: `packages/ui-preview/src/style.ts`.
Per screen: `ui-main-menu`, `ui-next-ride`, `ui-recycle-bin`, `ui-area-training/client/week.tsx` and `index.tsx`, `ui-devices` (`theme.tsx`, `setup.tsx`, `tile.tsx`), `ui-training-plan/client/theme.tsx`, `ui-debriefing`, `ui-ride-recovery`, `ui-tile-ride-start`, `ui-activity-screen`, `ui-hud-gauges` (`route-box.tsx`, `live-map.tsx`, `gauge.tsx`, `index.tsx`), `ui-widget-*`, `ui-debug-trainer`, `ui-bridge-pairing`, `ui-area-ride`. A mechanical pass over all plugin CSS replaced raw radii by the three radius tokens, hex fallbacks by plain tokens, and weights by the loaded ones.

## 4b. Second round (review findings)

- Removed the body-wide `font-family ... !important` rule; labels, display type and HUD figures now render in their own faces. One label style (mono, cyan) on the ride path.
- ERG: the shared card, volt when on (it was cyan, like a focus ring). Target power box uses the card.
- Top-bar current page: raised fill and volt icon, no ring. Briefing buttons, devices "Continue" and device rows use the 12 px radius, no border, the edge.
- Training plan theme: panel is a quiet card with the edge, nested fallbacks and a duplicate rule removed, classifier is the label.
- Raw colours replaced (gauge info text and gradient stops now tokens `--ridrs-card-glow/-top/-bottom`, route profile dot glow volt, world-video, file-drop incl. its 20 px radius, calendar navy hints and sizes below 11 px).
- Drag-over states are volt (training drop box, calendar days, next ride); cyan stays the focus.
- **Devices dialog focus (maintainer decision):** when the setup opens, the focus moves to the first device row (`focus({ focusVisible: true })`, so the ring shows after a pointer open too). The scenario `keyboard-navigation.feature:66` was changed first (test first): on open the focus is on the "Power Meter" row, Down, Down reaches "Heart Rate Monitor"; other steps unchanged. Only the devices setup changed; other dialogs keep their behaviour. `after/20-dialog-devices.jpg`: the element is the real `document.activeElement`, but the debug window is not the key window, so the ring is drawn by a style rule copied from the app's own onto that element.
- Muted text raised to `#b0bdd1` (about 5:1 on the card glow); `.nr-fact` is body text at reduced opacity.
- All `after/` screenshots re-captured from the live app; `45-ride-hud-erg-on.jpg` added.

## 5. Open issues

- **Zone charts** (workout charts) are still ten saturated hard-cornered bars; they are the most "aggressive" thing left on the training side. The palette is colour-blind checked, so it needs a decision, not a mechanical change (muted ramp, rounded tops).
- **Route profile / briefing profile** use the grade palette (earth tones). It is the same on the route box, so the HUD and briefing agree; the zone palette differs.
- **Compact and medium widths** were not re-captured (the window cannot be resized from the debug bridge): the trash, next ride and calendar rules for these were changed in CSS but are not verified by screenshot. Check the compact calendar and the trash hint on a phone-width window.
- **Not re-captured**: workout details and editor, route details, import/export dialogs, trash page; they take tokens but still have page-level details of the old themes (cyan mono field labels via the `-label` class match, "Edit copy of ... as a copy" title).
- The font layer in `kinetic.tsx` still keys on class-name endings (`-title`, `-label`...). That is the next structural step: explicit classes.
- A `<style>` element is still a child of the trash and some entry buttons.
- There is still no light theme.
- The workout widget in a ride with a workout was not seen live.
