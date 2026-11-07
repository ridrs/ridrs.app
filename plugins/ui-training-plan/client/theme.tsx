// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the device setup (docs/ux-draft): dark panels, cyan for "busy", lime for focus,
 * amber for "warn". Class names carry the plugin's prefix; plugins share no code.
 */
export const COLORS = {
  panel: '#0a1520',
  line: '#1f3447',
  cyan: '#27c8ff',
  lime: '#8dff2a',
  amber: '#ffb62e',
  muted: '#8b9db2',
  red: '#ff4d5e',
} as const;

const CSS = `
.rt-panel { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; height: 100%;
  padding: 20px; border: 1px solid var(--ridrs-line, ${COLORS.line}); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, ${COLORS.panel}); font: 500 14px system-ui, sans-serif;
  color: var(--ridrs-text, #fff); }
.rt-caption { display: inline-flex; align-items: center; gap: 8px; color: ${COLORS.muted}; font-size: 13px; }
.rt-hint { color: ${COLORS.muted}; font-size: 13px; }
.rt-warn { color: ${COLORS.amber}; }
.rt-muted { color: ${COLORS.muted}; }
.rt-button { padding: 10px 20px; border: 1.5px solid ${COLORS.line}; border-radius: 999px;
  background: ${COLORS.panel}; color: #fff; font: 600 15px system-ui, sans-serif; cursor: pointer; }
.rt-quiet { color: ${COLORS.muted}; }
.rt-card { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%;
  flex: 1; padding: 0; border: 0; border-radius: 12px; background: none; color: #fff;
  text-align: left; font: 500 14px system-ui, sans-serif; cursor: pointer; }
.rt-card .rt-classifier { color: ${COLORS.cyan}; font: 700 12px/1.2 system-ui, sans-serif;
  letter-spacing: .08em; text-transform: uppercase; }
.rt-card .rt-name { display: -webkit-box; overflow: hidden; margin-top: auto;
  font: 800 21px/1.2 system-ui, sans-serif; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  line-clamp: 2; overflow-wrap: anywhere; }
.rt-facts { display: flex; flex-wrap: wrap; gap: 0 6px; color: ${COLORS.muted}; }
.rt-facts > span + span::before { content: "·"; margin-right: 6px; }
.rt-profile { grid-column: 1 / -1; }
.rt-facts { display: flex; gap: 14px; color: ${COLORS.muted}; }
.rt-profile { display: flex; align-items: flex-end; gap: 2px; height: 36px; margin-top: 6px; }
.rt-profile i { display: block; min-width: 2px; border-radius: 2px 2px 0 0; opacity: .85; }
.rt-button:hover { border-color: ${COLORS.cyan}; }
.rt-card:hover .rt-name { color: ${COLORS.cyan}; }
.rt-button:focus-visible { outline: 2px solid ${COLORS.lime}; outline-offset: 2px; }
.rt-card:focus-visible { outline: 2px solid ${COLORS.lime}; outline-offset: 8px; }
.rt-spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid ${COLORS.cyan}40; border-top-color: ${COLORS.cyan}; animation: rt-spin 1s linear infinite; }
@keyframes rt-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rt-spin { animation: none; } }
.rt-details { box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; height: 100%;
  max-width: 720px; margin: 0 auto; padding: 32px 24px; overflow-y: auto; color: #fff;
  font: 500 15px system-ui, sans-serif; }
.rt-details header { display: flex; flex-direction: column; gap: 6px; }
.rt-details h1 { margin: 0; font-size: 30px; }
.rt-athlete { display: flex; gap: 8px 14px; margin: 0; color: ${COLORS.muted}; }
.rt-athlete dd { margin: 0 12px 0 0; color: #fff; font-weight: 700; }
.rt-description { margin: 0; white-space: pre-wrap; color: #d6e1ec; }
.rt-steps { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.rt-steps li { display: grid; grid-template-columns: 9em 6em 1fr; gap: 12px; padding: 8px 12px;
  border-radius: 8px; background: ${COLORS.panel}; }
.rt-steps li.rt-inner { margin-left: 24px; }
.rt-steps [data-field="target"] { color: ${COLORS.cyan}; }
.rt-details footer { display: flex; gap: 12px; }
`;

export function TrainingStyles() {
  return <style>{CSS}</style>;
}
