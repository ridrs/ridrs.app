// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the preview's pages and cards, drawn with the main screen's tokens (ADR 0058) and
 * fallbacks. Controls show their focus only when they have it (AGENTS.md rule 12); a pressed
 * toggle is filled, never outlined, so it never looks focused.
 */
export const PREVIEW_CSS = `
.pv-page { display: flex; flex-direction: column; gap: 28px; padding: 24px 40px 40px;
  color: var(--ridrs-text, #f2f5fa); font: 15px/1.4 system-ui, sans-serif; }
[data-breakpoint="compact"] .pv-page { padding: 16px; }
.pv-title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pv-title h1 { margin: 0; font-size: 28px; font-weight: 800; }
.pv-label { padding: 3px 9px; border: 1px solid var(--ridrs-warn, #ffb62e); border-radius: 999px;
  color: var(--ridrs-warn, #ffb62e); font: 700 11px system-ui, sans-serif; letter-spacing: .08em;
  text-transform: uppercase; }
.pv-muted { margin: 0; color: var(--ridrs-text-muted, #93a1b8); }
.pv-section { display: flex; flex-direction: column; gap: 12px; }
.pv-section > h2 { margin: 0; font-size: 18px; font-weight: 700; }
.pv-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: var(--ridrs-gap, 16px); }
.pv-card { display: flex; flex-direction: column; gap: 8px; padding: 16px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #131c2e); }
.pv-card h3 { margin: 0; font-size: 16px; }
.pv-card .pv-row:last-child { margin-top: auto; }
.pv-button, .pv-chip, .pv-icon { display: inline-flex; align-items: center; justify-content: center;
  gap: 8px; min-height: 40px; padding: 8px 14px; border: 0; border-radius: 12px;
  background: var(--ridrs-surface-raised, #1a2540); color: var(--ridrs-text, #f2f5fa);
  font: 600 14px system-ui, sans-serif; cursor: pointer; }
.pv-button:hover, .pv-chip:hover, .pv-icon:hover { filter: brightness(1.2); }
.pv-button:disabled { opacity: .45; cursor: default; filter: none; }
.pv-primary { background: var(--ridrs-accent, #b8f53b); color: var(--ridrs-accent-text, #0b1220); }
.pv-chip { border-radius: 999px; }
.pv-chip[aria-pressed="true"] { background: var(--ridrs-info, #2aa8ff); color: #fff; }
.pv-icon { width: 40px; padding: 0; }
.pv-icon[aria-pressed="true"] { color: var(--ridrs-warn, #ffb62e); }
.pv-button:focus-visible, .pv-chip:focus-visible, .pv-icon:focus-visible, .pv-open:focus-visible {
  outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.pv-glyph { flex: none; width: 18px; height: 18px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
.pv-icon[aria-pressed="true"] .pv-glyph { background: currentColor; }
.pv-open { display: flex; flex-direction: column; gap: 4px; padding: 0; border: 0;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pv-open strong { font-size: 16px; }
.pv-tile { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 20px;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa);
  font: 15px/1.4 system-ui, sans-serif; }
.pv-tile header { display: flex; align-items: center; gap: 10px; }
.pv-tile h2 { margin: 0; font-size: 18px; font-weight: 700; }
.pv-tile header .pv-icon { margin-left: auto; min-height: 32px; width: 32px; }
.pv-tile .pv-row:last-child { margin-top: auto; }
`;
