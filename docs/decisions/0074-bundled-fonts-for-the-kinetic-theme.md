<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0074: Bundled Fonts for the Kinetic Theme

Status: **proposed** on 2026-11-08, on the maintainer's request (five draft looks to compare in a theme picker; Kinetic, the look of the ridrs.app page, was picked, with thinner card titles, and its fonts bundled so the Mac app shows them). Draft; awaiting acceptance.

## Context

The draft themes in `plugins/ui-main-screen/client/themes.tsx` loaded their fonts from Google Fonts. The native app's CSP (`default-src 'self'`) blocks that, so the Mac app showed the system font. Kinetic uses Chakra Petch (headlines, italic), Plus Jakarta Sans (text) and JetBrains Mono (small labels), the fonts of the ridrs.app page.

## Decisions

- **Fontsource packages** (`@fontsource/chakra-petch`, `@fontsource/plus-jakarta-sans`, `@fontsource/jetbrains-mono`, 5.3.0, pinned): each ships the font files and an `@font-face` style sheet per subset and weight. Vite bundles the `.woff2` files into the app, so they load from `'self'` and work offline. Copying the files by hand would mean keeping them up to date by hand (rule 2).
- **Latin subset, light weights only:** Chakra Petch italic 400, 500 and 600; Plus Jakarta Sans 400 and 500; JetBrains Mono 400 and 500. Latin covers English and German. Plugins that ask for 700 or 800 get the heaviest loaded face, and `font-synthesis: none` stops the browser from faking bold, so the whole app reads lighter.
- **Loaded when the theme is applied:** `themes.tsx` imports the style sheets with a dynamic `import()` the first time Kinetic is chosen. Vite bundles them all the same; Node, which runs the UI scenarios and cannot load CSS, keeps the fallback fonts instead of failing the main screen.
- **License: SIL Open Font License 1.1** (`OFL-1.1`). It permits bundling the fonts with any software, AGPL included, as long as the license goes with them and the fonts are not sold on their own. It is not in the preferred list of LICENSING.md section 6; the maintainer asked for the bundling. The license texts are in `plugins/ui-main-screen/licenses/`, and NOTICE lists the packages.

## Consequences

- The app bundle grows by the woff2 files of the seven faces, about 100 KB.
- The other draft themes still load their fonts from Google Fonts and show the system font in the Mac app.
- Still a draft: the theme is kept in browser storage, not in app state (ADR 0068), and has no scenarios yet.
