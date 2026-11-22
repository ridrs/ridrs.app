// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the briefing: the design tokens of the main screen (ADR 0058, 0074), so light and
 * dark follow the app. On the ride path (AGENTS.md rule 12) the focused control always has the
 * focus ring; a chosen option is marked by a filled edge and a check, never by a ring, so no element
 * looks focused unless it is.
 */
const CSS = `
.br-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; max-width: 880px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text); font: 500 16px var(--ridrs-font-text); }
.br-title { margin: 0; font-size: 30px; font-weight: 500; }
.br-section { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px;
  border: 0; box-shadow: var(--ridrs-edge); border-radius: var(--ridrs-radius);
  background: var(--ridrs-card-quiet); }
.br-section h2 { margin: 0; }
.br-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.br-value { margin: 0; font-size: 20px; font-weight: 500; }
.br-hint { margin: 0; color: var(--ridrs-text-muted); font-size: 14px; }
.br-note { margin: 0; padding: 10px 14px; border-left: 3px solid var(--ridrs-info);
  background: var(--ridrs-surface-raised); border-radius: var(--ridrs-radius-sm); }
.br-problem { margin: 0; padding: 10px 14px; border-left: 3px solid var(--ridrs-warn);
  background: var(--ridrs-surface-raised); border-radius: var(--ridrs-radius-sm); color: var(--ridrs-warn); }
.br-button { padding: 10px 20px; border: 0; border-radius: var(--ridrs-radius); box-shadow: var(--ridrs-edge);
  background: var(--ridrs-surface-raised); color: inherit; font: inherit; font-weight: 500; cursor: pointer; }
.br-button:disabled { opacity: .5; cursor: default; }
.br-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.br-primary { box-shadow: none; background: var(--ridrs-accent);
  color: var(--ridrs-accent-text); font-size: 20px; font-weight: 500; padding: 14px 40px; }
.br-options { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none;
  max-height: 320px; overflow-y: auto; }
.br-group { margin: 8px 0 2px; }
.br-option { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 14px;
  border: 0; border-left: 4px solid transparent; border-radius: var(--ridrs-radius-sm); background: var(--ridrs-surface-raised);
  color: inherit; font: inherit; text-align: left; cursor: pointer; }
.br-option[aria-pressed="true"] { border-left-color: var(--ridrs-accent); font-weight: 500; }
.br-option[aria-pressed="true"]::after { content: '\\2713'; color: var(--ridrs-accent); }
.br-option small { color: var(--ridrs-text-muted); }
.br-pairs { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0; }
.br-pairs > div { display: flex; flex-direction: column; gap: 2px; }
.br-pairs dd { margin: 0; font-size: 20px; font-weight: 500; }
.br-pairs dt { color: var(--ridrs-text-muted); font-size: var(--ridrs-size-small); }
.br-zones { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 20px; margin: 0; }
.br-zones > div { display: flex; justify-content: space-between; gap: 12px; }
.br-zones dd { margin: 0; font-weight: 500; }
.br-fallback { margin: 0; padding: 12px; border: 1px dashed var(--ridrs-line); border-radius: var(--ridrs-radius);
  color: var(--ridrs-text-muted); }
.br-status { display: inline-flex; align-items: center; gap: 10px; }
.br-status[data-ok="true"]::before, .br-status[data-ok="false"]::before { content: ''; width: 10px; height: 10px;
  border-radius: 50%; background: var(--ridrs-ok); }
.br-status[data-ok="false"]::before { background: var(--ridrs-warn); }
.br-button:focus-visible, .br-option:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
`;

export function BriefingStyles() {
  return <style>{CSS}</style>;
}
