// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the briefing: the design tokens of the main screen (ADR 0058, 0074), so light and
 * dark follow the app. On the ride path (AGENTS.md rule 12) the focused control always has the
 * focus ring; a chosen option is marked by a filled edge and a check, never by a ring, so no element
 * looks focused unless it is.
 */
const CSS = `
.br-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; max-width: 880px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text, #fff); font: 500 16px system-ui, sans-serif; }
.br-title { margin: 0; font-size: 30px; font-weight: 800; }
.br-section { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px;
  border: 1px solid var(--ridrs-line, #1f3447); border-radius: var(--ridrs-radius, 16px);
  background: var(--ridrs-surface, #0a1520); }
.br-section h2 { margin: 0; color: var(--ridrs-text-muted, #8b9db2); font-size: 13px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase; }
.br-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.br-value { margin: 0; font-size: 20px; font-weight: 700; }
.br-hint { margin: 0; color: var(--ridrs-text-muted, #8b9db2); font-size: 14px; }
.br-note { margin: 0; padding: 10px 14px; border-left: 3px solid var(--ridrs-info, #2aa8ff);
  background: var(--ridrs-surface-raised, #12202e); border-radius: 8px; }
.br-problem { margin: 0; padding: 10px 14px; border-left: 3px solid var(--ridrs-warn, #ffb62e);
  background: var(--ridrs-surface-raised, #12202e); border-radius: 8px; color: var(--ridrs-warn, #ffb62e); }
.br-button { padding: 10px 20px; border: 1.5px solid var(--ridrs-line, #1f3447); border-radius: 999px;
  background: var(--ridrs-surface-raised, #12202e); color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.br-button:disabled { opacity: .5; cursor: default; }
.br-primary { border-color: var(--ridrs-accent, #b8f53b); background: var(--ridrs-accent, #b8f53b);
  color: var(--ridrs-accent-text, #0b1220); font-size: 20px; font-weight: 800; padding: 14px 40px; }
.br-options { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none;
  max-height: 320px; overflow-y: auto; }
.br-group { margin: 8px 0 2px; color: var(--ridrs-text-muted, #8b9db2); font-size: 12px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; }
.br-option { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 14px;
  border: 0; border-left: 4px solid transparent; border-radius: 8px; background: var(--ridrs-surface-raised, #12202e);
  color: inherit; font: inherit; text-align: left; cursor: pointer; }
.br-option[aria-pressed="true"] { border-left-color: var(--ridrs-accent, #b8f53b); font-weight: 700; }
.br-option[aria-pressed="true"]::after { content: '\\2713'; color: var(--ridrs-accent, #b8f53b); }
.br-option small { color: var(--ridrs-text-muted, #8b9db2); }
.br-pairs { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 0; }
.br-pairs > div { display: flex; flex-direction: column; gap: 2px; }
.br-pairs dd { margin: 0; font-size: 20px; font-weight: 700; }
.br-pairs dt { color: var(--ridrs-text-muted, #8b9db2); font-size: 12px; }
.br-zones { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 20px; margin: 0; }
.br-zones > div { display: flex; justify-content: space-between; gap: 12px; }
.br-zones dd { margin: 0; font-weight: 600; }
.br-fallback { margin: 0; padding: 12px; border: 1px dashed var(--ridrs-line, #1f3447); border-radius: 12px;
  color: var(--ridrs-text-muted, #8b9db2); }
.br-status { display: inline-flex; align-items: center; gap: 10px; }
.br-status[data-ok="true"]::before, .br-status[data-ok="false"]::before { content: ''; width: 10px; height: 10px;
  border-radius: 50%; background: var(--ridrs-ok, #3ddc84); }
.br-status[data-ok="false"]::before { background: var(--ridrs-warn, #ffb62e); }
.br-button:focus-visible, .br-option:focus-visible { outline: 3px solid var(--ridrs-focus, #8dff2a); outline-offset: 2px; }
`;

export function BriefingStyles() {
  return <style>{CSS}</style>;
}
