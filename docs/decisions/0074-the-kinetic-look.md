<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0074: The Kinetic Look

Status: **proposed** on 2026-11-08, on the maintainer's request (five look directions compared in a draft theme picker; Kinetic, the look of the ridrs.app page, picked as "the one and only theme", with thinner card titles, enough contrast on selected entries, its fonts bundled and never two outlined headlines on one page). Awaiting acceptance.

## Context

The app drew with the design tokens of ADR 0058 in blue and lime, and every plugin set its own `system-ui` font, mostly at weights 700 and 800, which read heavy. The ridrs.app page has a look of its own: near-black, neon cyan and volt yellow, Chakra Petch headlines with outlined letters, Plus Jakarta Sans for text and JetBrains Mono for small labels.

## Decisions

- **Kinetic is the app's only look.** No theme picker and no setting: `plugins/ui-main-screen/client/kinetic.tsx` adds one style sheet to the document's head when the main screen mounts and leaves it there, so screens that replace the main screen (the activity screen) keep the look. It sets the tokens of ADR 0058 on `:root` (they win over the main screen's own defaults) and lays a font layer over every plugin.
- **The font layer** sets Plus Jakarta Sans on every element, Chakra Petch (italic, upper case) on elements that read as headlines (headings and classes ending in `-title`, `-greeting`, `-name`) and JetBrains Mono on small labels (`-eyebrow`, `-classifier`, `-label`). Plugins keep their own style sheets; the layer overrides their font families with `!important`.
- **Lighter by loading less:** only the weights 400 to 600 are bundled, and `font-synthesis: none` stops the browser from faking bold. A plugin asking for 700 or 800 gets the heaviest loaded face. Card titles are 400.
- **One outlined headline per page:** the page's own title (the greeting on Today, an area's title) is outlined. Hero titles ("Ready to ride?") are solid Plus Jakarta Sans 500, neither italic nor upper case, and so are titles in a dialog, which stands over a page that has its own outlined title.
- **Dark text on cyan:** the selected menu entry, selected chips and busy badges set white on cyan (about 1.3:1); Kinetic gives them the near-black of the accent text (about 15:1).
- **Bundled fonts from Fontsource** (`@fontsource/chakra-petch`, `@fontsource/plus-jakarta-sans`, `@fontsource/jetbrains-mono`, 5.3.0, pinned), latin subset (English and German): Chakra Petch italic 400, 500, 600; Plus Jakarta Sans 400, 500; JetBrains Mono 400, 500. Vite bundles the `.woff2` files, so they load from `'self'` under the app's CSP and work offline; Google Fonts would be blocked. Copying the files by hand would mean keeping them current by hand (rule 2). The style sheets are imported with a dynamic `import()` when the main screen mounts: Node, which runs the UI scenarios, cannot load CSS and keeps the fallback fonts instead of failing the screen.
- **License: SIL Open Font License 1.1** (`OFL-1.1`). It permits bundling the fonts with any software, AGPL included, as long as the license goes with them and the fonts are not sold on their own. It is not in the preferred list of LICENSING.md section 6; the maintainer asked for the bundling. The license texts are in `plugins/ui-main-screen/licenses/`, NOTICE lists the packages, and Licenses & credits in the settings shows them (ADR 0073).

## Consequences

- The app bundle grows by the seven font faces, about 100 KB.
- Plugins still write their own colours and fonts; the layer reaches them through shared class-name endings. A plugin with other class names keeps Plus Jakarta Sans but no headline face, until it uses the tokens and these names.
- No scenarios: the look changes no behaviour, and the UI scenarios run without CSS.
