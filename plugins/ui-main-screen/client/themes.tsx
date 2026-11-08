// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DRAFT: five look directions to compare, switched with a small picker. A theme sets the design
 * tokens of ADR 0058 on `<html data-ridrs-theme>`, so every screen picks them up, and lays a font
 * layer over all plugins. The fonts come from Google Fonts with only light weights loaded, so the
 * 700 and 800 that plugins ask for fall back to the lighter faces (no faux bold).
 * Kinetic's fonts are bundled; the other drafts still load theirs from Google Fonts, which the
 * Tauri CSP blocks, so they show the system font in the Mac app. The choice
 * belongs in app state.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface Theme {
  readonly id: string;
  readonly name: string;
  readonly mood: string;
  readonly swatch: readonly string[];
  readonly fonts?: string;
  readonly css: string;
}

/** Elements that read as headlines across plugins: they take the display face. */
const HEAD = `:is(h1, h2, h3, [class$="-title"], [class*="-title "], [class$="-greeting"], [class$="-name"], [class$="-teaser-title"]):not([class^="tp-"])`;
/** Small uppercase labels ("FREE RIDE", "NEXT EVENT"). */
const LABEL = `:is([class$="-eyebrow"], [class$="-classifier"], [class$="-kicker"], [class*="-label"]):not([class^="tp-"])`;

const tokens = (id: string, values: string) =>
  `html[data-ridrs-theme="${id}"], html[data-ridrs-theme="${id}"] .ms-root { ${values} }`;

/** The font layer: body face everywhere, display face on headlines, no synthesized bold. */
const fontLayer = (id: string, body: string, display: string, head: string) => `
html[data-ridrs-theme="${id}"] body, html[data-ridrs-theme="${id}"] body * {
  font-family: ${body} !important; font-synthesis: none; }
html[data-ridrs-theme="${id}"] ${HEAD} { font-family: ${display} !important; ${head} }`;

export const THEMES: readonly Theme[] = [
  {
    id: 'original',
    name: 'Original',
    mood: 'Today’s look',
    swatch: ['#0b1220', '#b8f53b', '#2aa8ff'],
    css: '',
  },
  {
    id: 'velocity',
    name: 'Velocity',
    mood: 'Extreme · race number, blaze orange',
    swatch: ['#0a0a0a', '#ff4f00', '#f5f5f0'],
    fonts: 'family=Barlow:wght@400;500&family=Barlow+Condensed:ital,wght@1,500;1,600',
    css: `
${tokens('velocity', `--tp-glow: rgb(255 79 0 / .28); --ridrs-bg: #0a0a0a; --ridrs-surface: #141414; --ridrs-surface-raised: #1d1d1d;
  --ridrs-line: #2a2a2a; --ridrs-text: #f5f5f0; --ridrs-text-muted: #8f8f88; --ridrs-accent: #ff4f00;
  --ridrs-accent-text: #0a0a0a; --ridrs-info: #ff7a2e; --ridrs-ok: #3ddc84; --ridrs-warn: #ffc400;
  --ridrs-favourite: #ffc400; --ridrs-focus: #ff4f00; --ridrs-radius: 4px; --ridrs-gap: 12px;`)}
${fontLayer('velocity', `'Barlow', sans-serif`, `'Barlow Condensed', sans-serif`,
  'font-style: italic; text-transform: uppercase; letter-spacing: .01em; font-weight: 600 !important;')}
html[data-ridrs-theme="velocity"] .tb-greeting { font-size: 56px; line-height: .95; }
html[data-ridrs-theme="velocity"] ${LABEL} { letter-spacing: .14em; color: var(--ridrs-accent) !important; }
html[data-ridrs-theme="velocity"] .ms-root { background:
  repeating-linear-gradient(-60deg, transparent 0 22px, rgb(255 79 0 / .025) 22px 24px), var(--ridrs-bg); }
html[data-ridrs-theme="velocity"] .ms-root [data-tile] > * > * { border-radius: 4px !important; }
html[data-ridrs-theme="velocity"] .ms-root button { border-radius: 3px !important; }`,
  },
  {
    id: 'kinetic',
    name: 'Kinetic',
    mood: 'From ridrs.app · neon outline',
    swatch: ['#07090e', '#00f0ff', '#ccff00'],
    css: `
${tokens('kinetic', `--tp-glow: rgb(0 240 255 / .22); --ridrs-bg: #07090e; --ridrs-surface: #0d121c; --ridrs-surface-raised: #131b2a;
  --ridrs-line: #1b2a3c; --ridrs-text: #f1f5f9; --ridrs-text-muted: #8b9bb4; --ridrs-accent: #ccff00;
  --ridrs-accent-text: #07090e; --ridrs-info: #00f0ff; --ridrs-ok: #3ddc84; --ridrs-warn: #ffb62e;
  --ridrs-favourite: #ccff00; --ridrs-focus: #00f0ff; --ridrs-radius: 12px; --ridrs-gap: 16px;`)}
${fontLayer('kinetic', `'Plus Jakarta Sans', sans-serif`, `'Chakra Petch', sans-serif`,
  'font-style: italic; text-transform: uppercase; font-weight: 600 !important;')}
html[data-ridrs-theme="kinetic"] .ms-root { background:
  radial-gradient(ellipse 70% 45% at 55% -15%, rgb(0 240 255 / .14), transparent),
  radial-gradient(circle at 85% 95%, rgb(204 255 0 / .06), transparent 40%), var(--ridrs-bg); }
html[data-ridrs-theme="kinetic"] :is(.tb-greeting, .rs-title, .pv-hero-text h2, .pv-title h1) {
  color: transparent !important; -webkit-text-stroke: 1.3px var(--ridrs-text); font-size: 48px; }
html[data-ridrs-theme="kinetic"] .rs-title { -webkit-text-stroke-color: var(--ridrs-info); font-size: 38px; }
html[data-ridrs-theme="kinetic"] .mm-nav [data-menu-item][aria-current="page"] {
  color: var(--ridrs-accent-text) !important; }
html[data-ridrs-theme="kinetic"] :is(.pv-teaser-title, .dt-title, [data-tile] :is(h2, h3, [class$="-title"]):not(.rs-title)) {
  font-weight: 400 !important; font-size: 19px; line-height: 1.05; letter-spacing: -.02em; }
html[data-ridrs-theme="kinetic"] ${LABEL} { font-family: 'JetBrains Mono', monospace !important;
  color: var(--ridrs-info) !important; letter-spacing: .12em; }`,
  },
  {
    id: 'summit',
    name: 'Summit',
    mood: 'Extreme · alpine, signal yellow, outline',
    swatch: ['#101312', '#ffe600', '#eef2ee'],
    fonts: 'family=Big+Shoulders+Display:wght@600;700&family=Manrope:wght@400;500',
    css: `
${tokens('summit', `--tp-glow: rgb(255 230 0 / .12); --ridrs-bg: #101312; --ridrs-surface: #181c1a; --ridrs-surface-raised: #212623;
  --ridrs-line: #2d3430; --ridrs-text: #eef2ee; --ridrs-text-muted: #919c95; --ridrs-accent: #ffe600;
  --ridrs-accent-text: #101312; --ridrs-info: #ffe600; --ridrs-ok: #6ee69b; --ridrs-warn: #ff8a3d;
  --ridrs-favourite: #ffe600; --ridrs-focus: #ffe600; --ridrs-radius: 2px; --ridrs-gap: 10px;`)}
${fontLayer('summit', `'Manrope', sans-serif`, `'Big Shoulders Display', sans-serif`,
  'text-transform: uppercase; letter-spacing: .02em; font-weight: 700 !important;')}
html[data-ridrs-theme="summit"] .tb-greeting { font-size: 72px; line-height: .9; color: transparent !important;
  -webkit-text-stroke: 1.5px var(--ridrs-accent); }
html[data-ridrs-theme="summit"] :is(.rs-title, .pv-hero-text h2) { font-size: 44px; line-height: .95; }
html[data-ridrs-theme="summit"] ${LABEL} { letter-spacing: .2em; }
html[data-ridrs-theme="summit"] .ms-root [data-tile] > * > * { border-radius: 2px !important; }
html[data-ridrs-theme="summit"] .ms-root button { border-radius: 2px !important; text-transform: uppercase;
  letter-spacing: .06em; }
html[data-ridrs-theme="summit"] .ms-root [data-tile] > * > * { border-top: 2px solid var(--ridrs-accent) !important; }`,
  },
  {
    id: 'studio',
    name: 'Studio',
    mood: 'Fitness · light, calm, coral',
    swatch: ['#f4f2ee', '#ff5a36', '#16161a'],
    fonts: 'family=Inter:wght@400;500&family=Space+Grotesk:wght@500',
    css: `
${tokens('studio', `--tp-glow: rgb(255 90 54 / .16); --ridrs-bg: #f4f2ee; --ridrs-surface: #ffffff; --ridrs-surface-raised: #ece9e3;
  --ridrs-line: #e2ded6; --ridrs-text: #16161a; --ridrs-text-muted: #6b6a70; --ridrs-accent: #ff5a36;
  --ridrs-accent-text: #ffffff; --ridrs-info: #2d5bff; --ridrs-ok: #12a165; --ridrs-warn: #d98200;
  --ridrs-favourite: #ff5a36; --ridrs-focus: #16161a; --ridrs-radius: 22px; --ridrs-gap: 18px;`)}
${fontLayer('studio', `'Inter', sans-serif`, `'Space Grotesk', sans-serif`,
  'letter-spacing: -.02em; font-weight: 500 !important;')}
html[data-ridrs-theme="studio"] body { background: #f4f2ee; color: #16161a; }
html[data-ridrs-theme="studio"] .tb-greeting { font-size: 48px; }
html[data-ridrs-theme="studio"] .ms-root [data-tile] > * > * { box-shadow: 0 1px 2px rgb(0 0 0 / .04), 0 8px 24px rgb(0 0 0 / .05); }
html[data-ridrs-theme="studio"] .ms-root :is([data-hero], .pv-teaser[data-media]) :is(h1, h2, h3, strong, p, span) { color: #fff; }`,
  },
  {
    id: 'pulse',
    name: 'Pulse',
    mood: 'Fitness · heart-rate zones, soft & light',
    swatch: ['#120d1d', '#ff3d7f', '#8a7dff'],
    fonts: 'family=Outfit:wght@300;400;500',
    css: `
${tokens('pulse', `--tp-glow: rgb(255 61 127 / .3); --ridrs-bg: #120d1d; --ridrs-surface: #1b1428; --ridrs-surface-raised: #251c36;
  --ridrs-line: #2f2645; --ridrs-text: #f6f1ff; --ridrs-text-muted: #a59bba; --ridrs-accent: #ff3d7f;
  --ridrs-accent-text: #ffffff; --ridrs-info: #8a7dff; --ridrs-ok: #39e5a8; --ridrs-warn: #ffb03b;
  --ridrs-favourite: #ffb03b; --ridrs-focus: #ff3d7f; --ridrs-radius: 26px; --ridrs-gap: 18px;`)}
${fontLayer('pulse', `'Outfit', sans-serif`, `'Outfit', sans-serif`,
  'font-weight: 300 !important; letter-spacing: -.01em;')}
html[data-ridrs-theme="pulse"] .tb-greeting { font-size: 52px; }
html[data-ridrs-theme="pulse"] .ms-root { background:
  radial-gradient(circle at 100% 0%, rgb(255 61 127 / .12), transparent 45%),
  radial-gradient(circle at 0% 100%, rgb(138 125 255 / .12), transparent 45%), var(--ridrs-bg); }
html[data-ridrs-theme="pulse"] .ms-root::before { content: ""; position: fixed; inset: 0 0 auto; height: 4px; z-index: 5;
  background: linear-gradient(90deg, #8a8f9c 0 20%, #3d9bff 20% 40%, #39e5a8 40% 60%, #ffd23b 60% 80%, #ff3d7f 80%); }
html[data-ridrs-theme="pulse"] .ms-root [data-tile] > * > * { border-radius: 26px !important; }
html[data-ridrs-theme="pulse"] .ms-root :is(button, a)[class] { border-radius: 999px; }`,
  },
];

/**
 * Kinetic's fonts ship with the app (OFL-1.1, see NOTICE): latin only, and only the light weights,
 * so the heavier weights that plugins ask for fall back to them. Imported when the theme is first
 * applied: Vite bundles the style sheets and their font files, while Node (the UI scenarios) cannot
 * load CSS and the theme then keeps the fallback fonts.
 */
const BUNDLED_FONTS: Readonly<Record<string, () => Promise<unknown>>> = {
  kinetic: () =>
    Promise.all([
      import('@fontsource/chakra-petch/latin-400-italic.css'),
      import('@fontsource/chakra-petch/latin-500-italic.css'),
      import('@fontsource/chakra-petch/latin-600-italic.css'),
      import('@fontsource/plus-jakarta-sans/latin-400.css'),
      import('@fontsource/plus-jakarta-sans/latin-500.css'),
      import('@fontsource/jetbrains-mono/latin-400.css'),
      import('@fontsource/jetbrains-mono/latin-500.css'),
    ]),
};

const STORAGE_KEY = 'ridrs.draft-theme';

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'original';
  } catch {
    return 'original';
  }
}

function applyTheme(doc: Document, theme: Theme) {
  const root = doc.documentElement;
  root.dataset.ridrsTheme = theme.id;
  BUNDLED_FONTS[theme.id]?.().catch(() => undefined);
  if (theme.fonts && !doc.querySelector(`link[data-ridrs-font="${theme.id}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${theme.fonts}&display=swap`;
    link.dataset.ridrsFont = theme.id;
    doc.head.append(link);
  }
}

const PICKER_CSS = `
html[data-ridrs-theme]:not([data-ridrs-theme="original"]) .rs-tile { background:
  radial-gradient(120% 140% at 85% 0%, var(--tp-glow) 0%, transparent 60%),
  linear-gradient(160deg, var(--ridrs-surface-raised), var(--ridrs-surface)) !important; }
.tp-picker { position: fixed; right: 16px; bottom: 16px; z-index: 50; display: flex; align-items: center;
  gap: 6px; padding: 6px 8px; border: 1px solid rgb(128 128 128 / .35); border-radius: 999px;
  background: rgb(20 20 24 / .82); backdrop-filter: blur(10px); color: #fff;
  font: 400 12px system-ui, sans-serif !important; box-shadow: 0 8px 24px rgb(0 0 0 / .35); }
.tp-picker, .tp-picker * { font-family: system-ui, sans-serif !important; font-style: normal !important;
  text-transform: none !important; letter-spacing: normal !important; }
.tp-label { padding: 0 6px 0 4px; opacity: .7; white-space: nowrap; }
.tp-option { display: flex; padding: 3px; border: 2px solid transparent; border-radius: 999px;
  background: none; cursor: pointer; }
.tp-option[aria-pressed="true"] { border-color: #fff; }
.tp-option:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.tp-dots { display: flex; overflow: hidden; width: 30px; height: 18px; border-radius: 999px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / .2); }
.tp-dots i { display: block; flex: 1; height: 100%; }
.tp-dots i:first-child { flex: 1.4; }
.tp-name { min-width: 150px; padding: 0 6px; white-space: nowrap; }
.tp-name b { font-weight: 600; }
.tp-name span { display: block; opacity: .6; font-size: 11px; }
`;

/** The floating picker: one swatch per theme; a click, or Tab and Enter, switches. */
export function ThemePicker({ doc }: { readonly doc: Document }) {
  const [current, setCurrent] = useState(readStored);
  const theme = THEMES.find((entry) => entry.id === current) ?? (THEMES[0] as Theme);
  useEffect(() => {
    applyTheme(doc, theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme.id);
    } catch {
      // A preview without storage still switches.
    }
  }, [doc, theme]);
  // Outside the app's root, so the arrow-key navigation (ui-shell) never runs into it; the mouse
  // and Tab still reach it.
  return createPortal(
    <div className="tp-picker" role="group" aria-label="Theme (draft)">
      <style>{PICKER_CSS + THEMES.map((entry) => entry.css).join('\n')}</style>
      <span className="tp-label">Theme</span>
      {THEMES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="tp-option"
          aria-pressed={entry.id === theme.id}
          aria-label={entry.name}
          title={`${entry.name} — ${entry.mood}`}
          onClick={() => setCurrent(entry.id)}
        >
          <span className="tp-dots">
            {entry.swatch.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </span>
        </button>
      ))}
      <span className="tp-name">
        <b>{theme.name}</b>
        <span>{theme.mood}</span>
      </span>
    </div>,
    doc.body,
  );
}
