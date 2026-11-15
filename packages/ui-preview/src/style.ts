// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the preview's pages and cards, drawn with the main screen's tokens (ADR 0058) and
 * fallbacks. Controls show their focus only when they have it (AGENTS.md rule 12); a pressed
 * toggle is filled, never outlined, so it never looks focused.
 */
export const PREVIEW_CSS = `
.pv-page { display: flex; flex-direction: column; gap: 28px; padding: 24px 40px 40px;
  color: var(--ridrs-text); font: var(--ridrs-size-body)/1.4 var(--ridrs-font-text); }
[data-breakpoint="compact"] .pv-page { padding: 16px; }
.pv-title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pv-title h1 { margin: 0; font-size: 28px; font-weight: 500; }
.pv-label { padding: 3px 9px; border: 1px solid var(--ridrs-warn); border-radius: var(--ridrs-radius-pill);
  color: var(--ridrs-warn); font: 500 var(--ridrs-size-label) var(--ridrs-font-mono); letter-spacing: .12em;
  text-transform: uppercase; }
.pv-muted { margin: 0; color: var(--ridrs-text-muted); }
.pv-section { display: flex; flex-direction: column; gap: 12px; }
.pv-section > h2 { margin: 0; font-size: 18px; font-weight: 500; }
.pv-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: var(--ridrs-gap); }
/* In a grid a picture card takes its 16:10 from its column's width. With the height of the row
   (height: 100%) a taller card in the row, such as Import video, would widen it over its neighbour. */
.pv-cards > .pv-teaser[data-media] { width: 100%; height: auto; }
/* A wide grid (the routes of Ride) gives its rows the 16:10 of its columns and every card fills its
   cell, Import video too. WebKit keeps a row at its height when the cards in it change their size
   by their aspect ratio as the window resizes, so the rows are sized here, by the grid's width: as
   many columns of at least 300 px as fit, as auto-fill would. */
.pv-section:has(> .pv-cards[data-wide]) { container-type: inline-size; }
.pv-cards[data-wide] > .pv-teaser { width: auto; height: auto; min-height: 0; aspect-ratio: auto; }
.pv-cards[data-wide] { grid-template-columns: minmax(0, 1fr); grid-auto-rows: calc(100cqw * 10 / 16); }
@container (min-width: 616px) { .pv-cards[data-wide] { grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - var(--ridrs-gap)) / 2 * 10 / 16); } }
@container (min-width: 932px) { .pv-cards[data-wide] { grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - 2 * var(--ridrs-gap)) / 3 * 10 / 16); } }
@container (min-width: 1248px) { .pv-cards[data-wide] { grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - 3 * var(--ridrs-gap)) / 4 * 10 / 16); } }
@container (min-width: 1564px) { .pv-cards[data-wide] { grid-template-columns: repeat(5, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - 4 * var(--ridrs-gap)) / 5 * 10 / 16); } }
@container (min-width: 1880px) { .pv-cards[data-wide] { grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - 5 * var(--ridrs-gap)) / 6 * 10 / 16); } }
@container (min-width: 2196px) { .pv-cards[data-wide] { grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - 6 * var(--ridrs-gap)) / 7 * 10 / 16); } }
@container (min-width: 2512px) { .pv-cards[data-wide] { grid-template-columns: repeat(8, minmax(0, 1fr));
  grid-auto-rows: calc((100cqw - 7 * var(--ridrs-gap)) / 8 * 10 / 16); } }
[data-breakpoint="compact"] .pv-cards[data-wide] { grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: calc(100cqw * 10 / 16); }
.pv-card { display: flex; flex-direction: column; gap: 8px; padding: 16px;
  border: 0; border-radius: var(--ridrs-radius); box-shadow: var(--ridrs-edge);
  background: var(--ridrs-card-quiet); }
.pv-card h3 { margin: 0; font-size: 16px; }
.pv-card .pv-row:last-child { margin-top: auto; }
.pv-button, .pv-chip, .pv-icon { display: inline-flex; align-items: center; justify-content: center;
  gap: 8px; min-height: 40px; padding: 8px 14px; border: 0; border-radius: var(--ridrs-radius);
  background: var(--ridrs-surface-raised); box-shadow: var(--ridrs-edge); color: var(--ridrs-text);
  font: 500 14px var(--ridrs-font-text); cursor: pointer; transition: filter var(--ridrs-ease); }
.pv-button:hover, .pv-chip:hover, .pv-icon:hover { filter: brightness(1.2); }
.pv-button:disabled { opacity: .45; cursor: default; filter: none; }
.pv-primary { background: var(--ridrs-accent); box-shadow: none; color: var(--ridrs-accent-text); }
.pv-chip { border-radius: var(--ridrs-radius-pill); }
.pv-chip[aria-pressed="true"] { background: var(--ridrs-text); box-shadow: none; color: var(--ridrs-accent-text); }
.pv-icon { width: 40px; padding: 0; }
.pv-icon[aria-pressed="true"] { color: var(--ridrs-warn); }
.pv-favourite[aria-pressed="true"] { background: var(--ridrs-surface-raised);
  color: var(--ridrs-text); }
.pv-button:focus-visible, .pv-chip:focus-visible, .pv-icon:focus-visible, .pv-open:focus-visible {
  outline: var(--ridrs-focus-ring); outline-offset: 2px; }
.pv-glyph { flex: none; width: 18px; height: 18px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
.pv-icon[aria-pressed="true"] .pv-glyph { background: currentColor; }
.pv-favourite[aria-pressed="true"] .pv-glyph { background: var(--ridrs-favourite); }
.pv-open { display: flex; flex-direction: column; gap: 4px; padding: 0; border: 0;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pv-open strong { font-size: 16px; }
.pv-teaser { position: relative; isolation: isolate; display: flex; flex-direction: column;
  gap: 6px; height: 100%; min-height: 150px; padding: 18px 20px; overflow: hidden;
  border: 0; border-radius: var(--ridrs-radius); box-shadow: var(--ridrs-edge);
  background: var(--ridrs-card-quiet); color: var(--ridrs-text);
  font: var(--ridrs-size-body)/1.4 var(--ridrs-font-text); }
.pv-teaser[data-media] { min-height: 0; aspect-ratio: 16 / 10; padding: 19px 21px 13px 15px;
  border: 0; box-shadow: none; background: var(--ridrs-card); }
/* The edge of a picture card is drawn over the picture, so no background shows through around it. */
.pv-teaser[data-media]::after { content: ""; position: absolute; inset: 0; z-index: 1;
  border-radius: inherit; box-shadow: var(--ridrs-edge); pointer-events: none; }
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
  color: var(--ridrs-info); font: 500 var(--ridrs-size-label)/1.2 var(--ridrs-font-mono);
  letter-spacing: .08em; text-transform: uppercase; }
.pv-teaser-classifier .pv-glyph { width: 15px; height: 15px; }
.pv-teaser[data-media] .pv-teaser-classifier { color: #fff; text-shadow: 0 1px 4px rgb(0 0 0 / .6); }
.pv-teaser-open, .pv-teaser-text { display: flex; flex-direction: column; gap: 4px; margin-top: auto;
  padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
.pv-teaser-open { cursor: pointer; }
.pv-teaser-open::after { content: ""; position: absolute; inset: 0; }
.pv-teaser-open:focus-visible { outline: none; }
.pv-teaser:has(.pv-teaser-open:focus-visible) { outline: var(--ridrs-focus-ring);
  outline-offset: 2px; }
.pv-teaser-title { display: -webkit-box; overflow: hidden; font: 500 21px/1.2 var(--ridrs-font-text);
  -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; }
.pv-teaser-details { display: flex; align-items: center; overflow: hidden; color: var(--ridrs-text-muted); font-size: 14px;
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
.pv-teaser-tools .pv-icon { width: 34px; min-height: 34px; border-radius: 50%; box-shadow: none;
  background: rgb(11 18 32 / .55); backdrop-filter: blur(6px); }
.pv-teaser-tools .pv-label { background: rgb(11 18 32 / .55); }
.pv-badge { padding: 4px 10px; border-radius: var(--ridrs-radius-pill); background: rgb(11 18 32 / .7);
  color: var(--ridrs-text); font: 500 var(--ridrs-size-label) var(--ridrs-font-mono); white-space: nowrap;
  backdrop-filter: blur(6px); }
.pv-badge[data-tone="busy"] { background: rgb(11 18 32 / .7); color: var(--ridrs-accent); }
.pv-badge[data-tone="warn"] { background: var(--ridrs-warn); color: #0b1220; }
.pv-badge[data-tone="done"] { display: inline-flex; padding: 9px; background: rgb(11 18 32 / .55); }
.pv-badge .pv-glyph { width: 16px; height: 16px; }

.pv-detail, [data-breakpoint="compact"] .pv-detail { padding-top: 0; }
.pv-hero { position: relative; isolation: isolate; display: flex; flex-direction: column;
  justify-content: flex-end; height: clamp(260px, 46vh, 500px); margin: 0 -40px;
  padding: 96px 40px 24px; overflow: hidden;
  background: var(--ridrs-card); }
[data-breakpoint="compact"] .pv-hero { height: clamp(220px, 36vh, 340px); margin: 0 -16px;
  padding: 72px 16px 16px; }
.pv-hero-image { position: absolute; inset: 0; z-index: -2; width: 100%; height: 100%;
  object-fit: cover; }
.pv-hero::before { content: ""; position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(to top, var(--ridrs-bg) 0, var(--ridrs-bg) 3px,
    rgb(11 18 32 / .6) 28%,
    rgb(11 18 32 / 0) 58%), linear-gradient(to bottom, rgb(6 10 20 / .45), rgb(6 10 20 / 0) 26%); }
/* Level with the main screen's actions over the picture, and as tall: 44 px, 28 px from the top
   (12 px when compact). */
.pv-back { position: absolute; top: 28px; left: 40px; height: 44px; min-height: 44px;
  padding: 0 18px 0 14px; border: 1px solid rgb(255 255 255 / .14); border-radius: var(--ridrs-radius-pill);
  background: rgb(11 18 32 / .55); backdrop-filter: blur(8px); }
[data-breakpoint="compact"] .pv-back { top: 12px; left: 16px; }
.pv-hero-text { display: flex; flex-direction: column; gap: 6px; max-width: 960px;
  text-shadow: 0 1px 8px rgb(0 0 0 / .55); }
.pv-hero-text h2 { margin: 0; font: 500 34px/1.15 var(--ridrs-font-text); overflow-wrap: anywhere; }
[data-breakpoint="compact"] .pv-hero-text h2 { font-size: 24px; }

/* An area's title stands where the greeting of Today does: 40 px from the top, 40 px from the left
   (12 px and 16 px when compact), at the same size and trimmed to its letters. */
.pv-area { --pv-top: var(--ridrs-page-top); padding-top: var(--pv-top); }
[data-breakpoint="compact"] .pv-area { --pv-top: 12px; }
.pv-area .pv-title { gap: 12px 14px; }
.pv-area .pv-title h1 { font: 500 var(--ridrs-size-hero)/1.1 var(--ridrs-font-text); text-box: trim-both cap alphabetic; }
.pv-area > .pv-muted { margin-top: -14px; font-size: 20px; }
/* An area's picture: taller than a detail's, right under the top bar, the title over its top. */
.pv-area-hero { height: clamp(340px, 58vh, 620px); margin-top: calc(-1 * var(--pv-top));
  justify-content: space-between; gap: 14px; padding: var(--pv-top) 40px 40px; color: #f2f5fa; }
/* The title stays at the top, the introduction goes to the foot of the picture. */
.pv-area-hero .pv-hero-text { display: contents; }
[data-breakpoint="compact"] .pv-area-hero { height: clamp(280px, 48vh, 420px);
  padding: var(--pv-top) 16px 28px; }
.pv-area-hero .pv-hero-image { object-position: 55% 10%; }
.pv-area-hero::after { content: ""; position: absolute; inset: 0; z-index: -1;
  background: linear-gradient(to right, rgb(11 18 32 / .7), rgb(11 18 32 / 0) 60%); }
.pv-area-intro { margin: 0; max-width: 620px; color: rgb(242 245 250 / .88); font-size: 16px; }
[data-breakpoint="compact"] .pv-area-intro { font-size: 14px; }
.pv-credits { position: absolute; right: 40px; bottom: 10px; color: rgb(242 245 250 / .6);
  font: var(--ridrs-size-label) var(--ridrs-font-mono); text-shadow: 0 1px 4px rgb(0 0 0 / .6); }
[data-breakpoint="compact"] .pv-credits { right: 16px; bottom: 4px; }
`;
