// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The training plan's look is the unified one (docs/design/unified): cards, volt for the action,
 * cyan for information, amber for "warn". `COLORS` names the tokens. Class names carry the
 * plugin's prefix; plugins share no code.
 */
export const COLORS = {
  panel: 'var(--ridrs-card-quiet)',
  line: 'var(--ridrs-line)',
  cyan: 'var(--ridrs-info)',
  lime: 'var(--ridrs-accent)',
  amber: 'var(--ridrs-warn)',
  muted: 'var(--ridrs-text-muted)',
  red: 'var(--ridrs-danger)',
} as const;

const CSS = `
.rt-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; height: 100%;
  padding: 20px; border: 0; border-radius: var(--ridrs-radius); box-shadow: var(--ridrs-edge);
  background: var(--ridrs-card-quiet); font: 500 14px var(--ridrs-font-text);
  color: var(--ridrs-text); }
.rt-caption { display: inline-flex; align-items: center; gap: 8px; color: ${COLORS.muted}; font-size: 13px; }
.rt-hint { color: ${COLORS.muted}; font-size: 13px; }
.rt-warn { color: ${COLORS.amber}; }
.rt-muted { color: ${COLORS.muted}; }
.rt-button { padding: 10px 20px; border: 0; border-radius: var(--ridrs-radius); box-shadow: var(--ridrs-edge);
  background: var(--ridrs-surface-raised); color: var(--ridrs-text); font: 500 var(--ridrs-size-body) var(--ridrs-font-text); cursor: pointer; }
.rt-quiet { color: ${COLORS.muted}; }
.rt-card { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%;
  flex: 1; padding: 0; border: 0; border-radius: var(--ridrs-radius); background: none; color: var(--ridrs-text);
  text-align: left; font: 500 14px var(--ridrs-font-text); cursor: pointer; }
.rt-card .rt-name { display: -webkit-box; overflow: hidden; margin-top: auto;
  font: 500 21px/1.2 var(--ridrs-font-text); -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  line-clamp: 2; overflow-wrap: anywhere; }
.rt-facts { display: flex; flex-wrap: wrap; gap: 0 14px; color: ${COLORS.muted}; }
.rt-facts > span + span::before { content: "·"; margin-right: 6px; }
.rt-profile { grid-column: 1 / -1; margin-top: 6px; }
.tr-chart { pointer-events: none; }
.tr-chart:empty { display: none; }
.rt-button:hover { filter: brightness(1.2); }
.rt-card:hover .rt-name { color: var(--ridrs-accent); }
.rt-button:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
.rt-card:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 8px; border-radius: var(--ridrs-radius); }
.rt-spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgb(255 255 255 / .2); border-top-color: ${COLORS.cyan}; animation: rt-spin 1s linear infinite; }
@keyframes rt-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rt-spin { animation: none; } }
.rt-details { box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; height: 100%;
  max-width: 720px; margin: 0 auto; padding: 32px 24px; overflow-y: auto; color: var(--ridrs-text);
  font: 500 15px var(--ridrs-font-text); }
.rt-details header { display: flex; flex-direction: column; gap: 6px; }
.rt-details h1 { margin: 0; font-size: 30px; }
.rt-athlete { display: flex; gap: 8px 14px; margin: 0; color: ${COLORS.muted}; }
.rt-athlete dd { margin: 0 12px 0 0; color: var(--ridrs-text); font-weight: 500; }
.rt-description { margin: 0; white-space: pre-wrap; color: var(--ridrs-text-muted); }
.rt-steps { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.rt-steps li { display: grid; grid-template-columns: 9em 6em 1fr; gap: 12px; padding: 8px 12px;
  border-radius: var(--ridrs-radius-sm); background: ${COLORS.panel}; }
.rt-steps li.rt-inner { margin-left: 24px; }
.rt-steps [data-field="target"] { color: ${COLORS.cyan}; }
.rt-details footer { display: flex; gap: 12px; }
`;

export function TrainingStyles() {
  return <style>{CSS}</style>;
}
