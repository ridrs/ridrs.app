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
.pv-cards[data-wide] { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
[data-breakpoint="compact"] .pv-cards[data-wide] { grid-template-columns: minmax(0, 1fr); }
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
.pv-favourite[aria-pressed="true"] { background: var(--ridrs-surface-raised, #1a2540);
  color: var(--ridrs-text, #f2f5fa); }
.pv-button:focus-visible, .pv-chip:focus-visible, .pv-icon:focus-visible, .pv-open:focus-visible {
  outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.pv-glyph { flex: none; width: 18px; height: 18px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
.pv-icon[aria-pressed="true"] .pv-glyph { background: currentColor; }
.pv-favourite[aria-pressed="true"] .pv-glyph { background: var(--ridrs-favourite, #ffd60a); }
.pv-open { display: flex; flex-direction: column; gap: 4px; padding: 0; border: 0;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pv-open strong { font-size: 16px; }
.pv-teaser { position: relative; isolation: isolate; display: flex; flex-direction: column;
  gap: 6px; height: 100%; min-height: 150px; padding: 18px 20px; overflow: hidden;
  border: 1px solid var(--ridrs-line, #24324d); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa);
  font: 15px/1.4 system-ui, sans-serif; }
.pv-teaser[data-media] { min-height: 0; aspect-ratio: 16 / 10; padding: 19px 21px 13px 15px;
  border: 0;
  background: radial-gradient(120% 90% at 85% 0%, #2a4a78 0%, transparent 60%),
    linear-gradient(160deg, #1b2d4d, #0d1626); }
/* The edge of a picture card is drawn over the picture, so no background shows through around it. */
.pv-teaser[data-media]::after { content: ""; position: absolute; inset: 0; z-index: 1;
  border-radius: inherit; box-shadow: inset 0 0 0 1px rgb(255 255 255 / .12); pointer-events: none; }
.pv-teaser[data-media]::before { content: ""; position: absolute; inset: 0; z-index: -1;
  background: radial-gradient(85% 55% at 0% 100%, rgb(6 10 20 / .7), rgb(6 10 20 / 0) 100%),
    linear-gradient(to top, rgb(6 10 20 / .95) 0%, rgb(6 10 20 / .72) 38%, rgb(6 10 20 / 0) 75%),
    linear-gradient(to bottom, rgb(6 10 20 / .45), rgb(6 10 20 / 0) 30%); }
.pv-teaser-image { position: absolute; inset: 0; z-index: -2; width: 100%; height: 100%;
  object-fit: cover; transition: transform .4s ease; }
.pv-teaser:has(.pv-teaser-open:hover) .pv-teaser-image { transform: scale(1.04); }
.pv-teaser-backdrop { position: absolute; inset: auto 0 0; z-index: -1; height: 42%;
  pointer-events: none; }
.pv-teaser-backdrop > * { display: block; width: 100%; height: 100%; }
.pv-teaser-classifier { display: inline-flex; align-items: center; gap: 6px; padding-right: 96px;
  color: var(--ridrs-info, #2aa8ff); font: 700 12px/1.2 system-ui, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; }
.pv-teaser-classifier .pv-glyph { width: 15px; height: 15px; }
.pv-teaser[data-media] .pv-teaser-classifier { color: #fff; text-shadow: 0 1px 4px rgb(0 0 0 / .6); }
.pv-teaser-open, .pv-teaser-text { display: flex; flex-direction: column; gap: 4px; margin-top: auto;
  padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
.pv-teaser-open { cursor: pointer; }
.pv-teaser-open::after { content: ""; position: absolute; inset: 0; }
.pv-teaser-open:focus-visible { outline: none; }
.pv-teaser:has(.pv-teaser-open:focus-visible) { outline: 3px solid var(--ridrs-focus, #fff);
  outline-offset: 2px; }
.pv-teaser-title { display: -webkit-box; overflow: hidden; font: 800 21px/1.2 system-ui, sans-serif;
  -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; }
.pv-teaser-details { display: flex; align-items: center; overflow: hidden; color: var(--ridrs-text-muted, #93a1b8); font-size: 14px;
  white-space: nowrap; text-overflow: ellipsis; }
.pv-teaser-fact { display: inline-flex; align-items: center; gap: 6px; }
.pv-teaser-details > * + .pv-teaser-fact, .pv-teaser-fact + * { margin-left: 14px; }
.pv-teaser-fact .pv-glyph { width: 15px; height: 15px; opacity: .85; }
.pv-teaser[data-media] .pv-teaser-title, .pv-teaser[data-media] .pv-teaser-details {
  text-shadow: 0 1px 6px rgb(0 0 0 / .5); }
.pv-teaser[data-media] .pv-teaser-details { color: rgb(255 255 255 / .82); }
.pv-teaser > .pv-row { position: relative; margin-top: 6px; }
.pv-teaser-tools { position: absolute; top: 10px; right: 10px; display: flex; align-items: center;
  gap: 6px; }
.pv-teaser-tools .pv-icon { width: 34px; min-height: 34px; border-radius: 50%;
  background: rgb(11 18 32 / .55); backdrop-filter: blur(6px); }
.pv-teaser-tools .pv-label { background: rgb(11 18 32 / .55); }
.pv-badge { padding: 4px 10px; border-radius: 999px; background: rgb(11 18 32 / .7);
  color: var(--ridrs-text, #f2f5fa); font: 700 12px system-ui, sans-serif; white-space: nowrap;
  backdrop-filter: blur(6px); }
.pv-badge[data-tone="busy"] { background: var(--ridrs-info, #2aa8ff); color: #fff; }
.pv-badge[data-tone="warn"] { background: var(--ridrs-warn, #ffb62e); color: #0b1220; }
.pv-badge[data-tone="done"] { display: inline-flex; padding: 9px; background: rgb(11 18 32 / .55); }
.pv-badge .pv-glyph { width: 16px; height: 16px; }

.pv-detail, [data-breakpoint="compact"] .pv-detail { padding-top: 0; }
.pv-hero { position: relative; isolation: isolate; display: flex; flex-direction: column;
  justify-content: flex-end; height: clamp(260px, 46vh, 500px); margin: 0 -40px;
  padding: 96px 40px 24px; overflow: hidden;
  background: radial-gradient(120% 90% at 85% 0%, #2a4a78 0%, transparent 60%),
    linear-gradient(160deg, #1b2d4d, #0d1626); }
[data-breakpoint="compact"] .pv-hero { height: clamp(220px, 36vh, 340px); margin: 0 -16px;
  padding: 72px 16px 16px; }
.pv-hero-image { position: absolute; inset: 0; z-index: -2; width: 100%; height: 100%;
  object-fit: cover; }
.pv-hero::before { content: ""; position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(to top, var(--ridrs-bg, #0b1220) 0, var(--ridrs-bg, #0b1220) 3px,
    rgb(11 18 32 / .6) 28%,
    rgb(11 18 32 / 0) 58%), linear-gradient(to bottom, rgb(6 10 20 / .45), rgb(6 10 20 / 0) 26%); }
/* Level with the main screen's actions over the picture, and as tall: 44 px, 28 px from the top
   (12 px when compact). */
.pv-back { position: absolute; top: 28px; left: 40px; height: 44px; min-height: 44px;
  padding: 0 18px 0 14px; border: 1px solid rgb(255 255 255 / .14); border-radius: 999px;
  background: rgb(11 18 32 / .55); backdrop-filter: blur(8px); }
[data-breakpoint="compact"] .pv-back { top: 12px; left: 16px; }
.pv-hero-text { display: flex; flex-direction: column; gap: 6px; max-width: 960px;
  text-shadow: 0 1px 8px rgb(0 0 0 / .55); }
.pv-hero-text h2 { margin: 0; font: 800 34px/1.15 system-ui, sans-serif; overflow-wrap: anywhere; }
[data-breakpoint="compact"] .pv-hero-text h2 { font-size: 24px; }
`;
