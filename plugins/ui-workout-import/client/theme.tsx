// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the import (ADR 0074): the design tokens of the main screen; class names carry the
 * prefix `wi-` and the Kinetic endings (`-title`, `-label`). Controls show their focus only when
 * they have it (AGENTS.md rule 12). Off the ride path (ADR 0080): a pointer is enough, the
 * controls keep their standard keyboard behaviour.
 */
const CSS = `
.wi-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; max-width: 820px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text); font: 500 15px var(--ridrs-font-text); }
.wi-title { margin: 0; font-size: 26px; font-weight: 500; }
.wi-page h2 { margin: 0 0 8px; font-size: 15px; color: var(--ridrs-text-muted); }
.wi-muted { margin: 0; color: var(--ridrs-text-muted); }
.wi-drop { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px 16px;
  border: 2px dashed var(--ridrs-line); border-radius: var(--ridrs-radius); text-align: center; }
.wi-drop[data-over="true"] { border-color: var(--ridrs-accent); }
.wi-button { display: inline-flex; align-items: center; justify-content: center; min-height: 40px;
  padding: 8px 20px; border: 1.5px solid var(--ridrs-line); border-radius: var(--ridrs-radius-pill);
  background: var(--ridrs-surface); color: inherit; font: inherit; cursor: pointer; }
.wi-button:disabled { opacity: .45; cursor: default; }
.wi-primary { border-color: transparent; background: var(--ridrs-accent); color: var(--ridrs-accent-text); }
.wi-file { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); opacity: 0; }
:root[data-input-mode="keyboard"] .wi-button:has(.wi-file:focus),
:root[data-input-mode="pointer"]:not([data-cursor-hidden]) label.wi-button:hover {
  outline: var(--ridrs-highlight-ring, var(--ridrs-focus-ring));
  outline-offset: var(--ridrs-highlight-offset, 2px); }
.wi-paste { display: flex; flex-direction: column; gap: 8px; }
.wi-text, .wi-name { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 0; box-shadow: var(--ridrs-edge);
  border-radius: var(--ridrs-radius-sm); background: var(--ridrs-card-quiet); color: inherit; font: inherit; }
.wi-text { min-height: 90px; font-family: ui-monospace, monospace; font-size: 13px; }
.wi-rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.wi-row { display: grid; grid-template-columns: 160px 1fr; gap: 14px; padding: 12px; border: 0; box-shadow: var(--ridrs-edge);
  border-radius: var(--ridrs-radius); background: var(--ridrs-card-quiet); }
.wi-row[data-state="error"] { border-color: var(--ridrs-danger); }
.wi-chart { min-height: 56px; }
.wi-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wi-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.wi-name-text { font-size: 17px; }
.wi-state { font-size: 18px; }
.wi-state[data-state="ok"] { color: var(--ridrs-ok); }
.wi-state[data-state="warning"] { color: var(--ridrs-warn); }
.wi-state[data-state="error"] { color: var(--ridrs-danger); }
.wi-label { color: var(--ridrs-text-muted); font-size: 12px; }
.wi-notes { margin: 0; padding: 0; list-style: none; font-size: 14px; }
.wi-choice { display: flex; gap: 16px; margin-top: 4px; }
.wi-choice label { display: inline-flex; gap: 6px; align-items: center; }
.wi-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
@media (max-width: 560px) { .wi-row { grid-template-columns: 1fr; } }
`;

export function ImportStyles() {
  return <style>{CSS}</style>;
}
