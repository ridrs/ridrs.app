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

/**
 * Small uppercase labels ("FREE RIDE", "NEXT EVENT", the briefing's section heads, a figure's name):
 * one style everywhere. New code asks for it with \`data-label\` or \`.ridrs-label\`; the rest are
 * the old class names that were labels already.
 */
const LABEL_ONLY = `.ridrs-label, [data-label], .nr-title, .br-section > h2, .br-group, .db-facts dt, .rt-classifier`;
const LABEL = `:is([class$="-eyebrow"], [class$="-classifier"], [class$="-kicker"], [class*="-label"], ${LABEL_ONLY})`;
/** Elements that read as headlines across plugins: they take the display face (labels excepted). */
const HEAD = `:is(h1, h2, h3, [class$="-title"], [class*="-title "], [class$="-greeting"], [class$="-name"], [class$="-teaser-title"]):not(${LABEL_ONLY})`;
/** The page titles that are outlined. */
const OUTLINED = `:is(.tb-greeting, .pv-title h1):not(.ms-dialog *)`;
/** Hero titles: big, solid, in the text face. */
const HERO = `:is(.rs-title, .pv-hero-text h2, .ms-dialog .pv-title h1)`;

/**
 * The design tokens of ridrs, one set (docs/design/unified): the language of the route cards on Ride
 * and of the route box in the ride. A surface is the navy card (gradient and light edge), shapes
 * are 8 / 12 / 16 px or a pill, a label is small mono capitals, a number is tabular, volt marks the
 * action and the progress, cyan the focus and the information. Plugins draw with these names only.
 */
export const TOKENS = `
  --ridrs-bg: #07090e; --ridrs-surface: #0e1523; --ridrs-surface-raised: #17233a;
  --ridrs-card-glow: #2a4a78; --ridrs-card-top: #1b2d4d; --ridrs-card-bottom: #0d1626;
  --ridrs-card: radial-gradient(120% 90% at 85% 0%, var(--ridrs-card-glow) 0%, transparent 60%), linear-gradient(160deg, var(--ridrs-card-top), var(--ridrs-card-bottom));
  --ridrs-card-quiet: linear-gradient(160deg, #15233b, #0d1626);
  --ridrs-edge: inset 0 0 0 1px rgb(255 255 255 / .12);
  --ridrs-shadow: 0 10px 28px rgb(0 0 0 / .38);
  --ridrs-line: rgb(255 255 255 / .14);
  --ridrs-text: #f1f5f9; --ridrs-text-muted: #b0bdd1;
  --ridrs-accent: #ccff00; --ridrs-accent-text: #07090e; --ridrs-on-accent: #07090e;
  --ridrs-info: #00f0ff; --ridrs-ok: #3ddc84; --ridrs-warn: #ffb62e; --ridrs-danger: #ff5a6e;
  --ridrs-favourite: #ccff00; --ridrs-focus: #00f0ff;
  --ridrs-radius-sm: 8px; --ridrs-radius: 12px; --ridrs-radius-lg: 16px; --ridrs-radius-pill: 999px;
  --ridrs-gap: 16px; --ridrs-gap-sm: 8px;
  --ridrs-font-text: 'Plus Jakarta Sans', sans-serif; --ridrs-font-display: 'Chakra Petch', sans-serif;
  --ridrs-font-mono: 'JetBrains Mono', monospace;
  --ridrs-size-label: 11px; --ridrs-size-small: 13px; --ridrs-size-body: 15px; --ridrs-size-title: 19px;
  --ridrs-size-value: 28px; --ridrs-size-hero: 40px;
  --ridrs-ease: .15s ease;
  --ridrs-focus-ring: 3px solid var(--ridrs-focus);
`;

const CSS = `
:root, :root .ms-root { ${TOKENS} }
:root body { background: var(--ridrs-bg); }
:root body { font-family: var(--ridrs-font-text); font-synthesis: none; }
/* Controls take the page's face, but a plugin's own font (a label, a display title) still wins. */
:where(button, input, select, textarea) { font-family: inherit; }
:root ${HEAD} { font-family: var(--ridrs-font-display) !important; font-style: italic;
  text-transform: uppercase; font-weight: 600 !important; }
:root .ms-root { background:
  radial-gradient(ellipse 70% 45% at 55% -15%, rgb(0 240 255 / .14), transparent),
  radial-gradient(circle at 85% 95%, rgb(204 255 0 / .06), transparent 40%), var(--ridrs-bg); }
:root ${OUTLINED} { color: transparent !important; -webkit-text-stroke: 1.3px var(--ridrs-text); font-size: 48px; }
:root ${HERO} { font-family: var(--ridrs-font-text) !important; font-style: normal;
  text-transform: none; font-weight: 500 !important; letter-spacing: -.025em; line-height: 1.05; }
:root .rs-title { font-size: 40px; }
/* A selected chip is filled light, never cyan: cyan is the focus ring, and selected is not focused. */
:root .pv-chip[aria-pressed="true"] {
  background: var(--ridrs-text) !important; color: var(--ridrs-accent-text) !important; }
:root :is(.pv-teaser-title, .dt-title, [data-tile] :is(h2, h3, [class$="-title"]):not(.rs-title)) {
  font-weight: 400 !important; font-size: var(--ridrs-size-title); line-height: 1.05; letter-spacing: -.02em; }
:root ${LABEL} { font-family: var(--ridrs-font-mono) !important; color: var(--ridrs-info) !important;
  font-size: var(--ridrs-size-label); font-style: normal; font-weight: 500; letter-spacing: .12em;
  text-transform: uppercase; }
/* Figures never jitter. */
:root :is([data-testid="value"], [data-numeric], .tnum) { font-variant-numeric: tabular-nums; }
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
