// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Kinetic, the look of ridrs (ADR 0074): the look of the ridrs.app page. It sets the design tokens
 * of ADR 0058 on the document, so every screen picks them up, and lays a font layer over all
 * plugins: Plus Jakarta Sans for text, Chakra Petch (italic, upper case) for headlines, JetBrains
 * Mono for small labels. Only light weights are bundled, so the 700 and 800 that plugins ask for
 * fall back to them and the app reads lighter (no faux bold).
 *
 * One outlined headline per page: the page's own title (the greeting on Today, an area's title).
 * Hero titles ("Ready to ride?") are solid Plus Jakarta Sans, and so are titles in a dialog, which
 * stands over a page that has its own.
 */
import { useEffect } from 'react';

/** Elements that read as headlines across plugins: they take the display face. */
const HEAD = `:is(h1, h2, h3, [class$="-title"], [class*="-title "], [class$="-greeting"], [class$="-name"], [class$="-teaser-title"])`;
/** Small uppercase labels ("FREE RIDE", "NEXT EVENT"). */
const LABEL = `:is([class$="-eyebrow"], [class$="-classifier"], [class$="-kicker"], [class*="-label"])`;
/** The page titles that are outlined. */
const OUTLINED = `:is(.tb-greeting, .pv-title h1):not(.ms-dialog *)`;
/** Hero titles: big, solid, in the text face. */
const HERO = `:is(.rs-title, .pv-hero-text h2, .ms-dialog .pv-title h1)`;

const CSS = `
:root, :root .ms-root { --ridrs-bg: #07090e; --ridrs-surface: #0d121c; --ridrs-surface-raised: #131b2a;
  --ridrs-line: #1b2a3c; --ridrs-text: #f1f5f9; --ridrs-text-muted: #8b9bb4; --ridrs-accent: #ccff00;
  --ridrs-accent-text: #07090e; --ridrs-info: #00f0ff; --ridrs-ok: #3ddc84; --ridrs-warn: #ffb62e;
  --ridrs-favourite: #ccff00; --ridrs-focus: #00f0ff; --ridrs-radius: 12px; --ridrs-gap: 16px; }
:root body { background: var(--ridrs-bg); }
:root body, :root body * { font-family: 'Plus Jakarta Sans', sans-serif !important; font-synthesis: none; }
:root ${HEAD} { font-family: 'Chakra Petch', sans-serif !important; font-style: italic;
  text-transform: uppercase; font-weight: 600 !important; }
:root .ms-root { background:
  radial-gradient(ellipse 70% 45% at 55% -15%, rgb(0 240 255 / .14), transparent),
  radial-gradient(circle at 85% 95%, rgb(204 255 0 / .06), transparent 40%), var(--ridrs-bg); }
:root ${OUTLINED} { color: transparent !important; -webkit-text-stroke: 1.3px var(--ridrs-text); font-size: 48px; }
:root ${HERO} { font-family: 'Plus Jakarta Sans', sans-serif !important; font-style: normal;
  text-transform: none; font-weight: 500 !important; letter-spacing: -.025em; line-height: 1.05; }
:root .rs-title { font-size: 40px; }
:root .rs-tile { background: radial-gradient(120% 140% at 85% 0%, rgb(0 240 255 / .22) 0%, transparent 60%),
  linear-gradient(160deg, var(--ridrs-surface-raised), var(--ridrs-surface)) !important; }
/* Dark text on the cyan of a selected entry or chip: white on it has far too little contrast. */
:root :is(.mm-nav [data-menu-item][aria-current="page"], .pv-chip[aria-pressed="true"], .pv-badge[data-tone="busy"]) {
  color: var(--ridrs-accent-text) !important; }
:root :is(.pv-teaser-title, .dt-title, [data-tile] :is(h2, h3, [class$="-title"]):not(.rs-title)) {
  font-weight: 400 !important; font-size: 19px; line-height: 1.05; letter-spacing: -.02em; }
:root ${LABEL} { font-family: 'JetBrains Mono', monospace !important; color: var(--ridrs-info) !important;
  letter-spacing: .12em; }
`;

/**
 * The bundled fonts (OFL-1.1, see NOTICE): latin only, light weights only. Imported at mount: Vite
 * bundles the style sheets and their font files, while Node (the UI scenarios) cannot load CSS and
 * keeps the fallback fonts.
 */
const loadFonts = () =>
  Promise.all([
    import('@fontsource/chakra-petch/latin-400-italic.css'),
    import('@fontsource/chakra-petch/latin-500-italic.css'),
    import('@fontsource/chakra-petch/latin-600-italic.css'),
    import('@fontsource/plus-jakarta-sans/latin-400.css'),
    import('@fontsource/plus-jakarta-sans/latin-500.css'),
    import('@fontsource/jetbrains-mono/latin-400.css'),
    import('@fontsource/jetbrains-mono/latin-500.css'),
  ]);

/**
 * Adds the Kinetic style sheet to the document's head once and loads its fonts. It stays there when
 * the main screen gives way to another screen (the activity screen during a ride).
 */
export function KineticStyle({ doc }: { readonly doc: Document }) {
  useEffect(() => {
    if (!doc.head.querySelector('style[data-ridrs-look="kinetic"]')) {
      const style = doc.createElement('style');
      style.dataset.ridrsLook = 'kinetic';
      style.textContent = CSS;
      doc.head.append(style);
    }
    loadFonts().catch(() => undefined);
  }, [doc]);
  return null;
}
