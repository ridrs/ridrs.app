// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the editor: the design tokens of the main screen (ADR 0058, 0074), so light and
 * dark follow the app. A workbench screen: pointer and touch first, so the grips and buttons are
 * large enough to hit; the focused control has the focus ring.
 */
const CSS = `
.we-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; max-width: 900px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text); font: 500 15px var(--ridrs-font-text); }
.we-page h1 { margin: 0; font-size: 28px; font-weight: 500; }
.we-page h2 { margin: 0 0 8px; font-size: 15px; color: var(--ridrs-text-muted); }
.we-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.we-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.we-button { min-height: 36px; padding: 6px 16px; border: 1.5px solid var(--ridrs-line); border-radius: var(--ridrs-radius-pill);
  background: var(--ridrs-surface); color: inherit; font: inherit; cursor: pointer; }
.we-button[disabled] { opacity: .45; cursor: default; }
.we-primary { border-color: var(--ridrs-accent); color: var(--ridrs-accent); }
.we-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.we-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.we-label { color: var(--ridrs-text-muted); font-size: 12px; }
.we-page input, .we-page select, .we-page textarea { box-sizing: border-box; min-height: 36px; padding: 6px 10px;
  border: 1.5px solid var(--ridrs-line); border-radius: var(--ridrs-radius-sm); background: var(--ridrs-surface);
  color: inherit; font: inherit; min-width: 0; }
.we-page input[aria-invalid="true"] { border-color: var(--ridrs-danger); }
.we-numbers { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; }
.we-numbers > div { display: flex; flex-direction: column; gap: 2px; }
.we-numbers dd { margin: 0; font-size: 18px; }
.we-numbers dt { color: var(--ridrs-text-muted); font-size: 12px; }
.we-hint { color: var(--ridrs-text-muted); font-size: 13px; margin: 0; }
.we-add { display: flex; flex-wrap: wrap; gap: 8px; }
.we-steps { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.we-steps .we-steps { margin-left: 22px; padding-left: 10px; border-left: 2px solid var(--ridrs-line); margin-top: 6px; }
.we-row { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 0; border-left: 3px solid transparent;
  border-radius: var(--ridrs-radius-sm); background: var(--ridrs-surface); }
.we-row[data-selected] { border-left-color: var(--ridrs-accent); background: var(--ridrs-surface-raised); }
.we-row[data-over] { outline: 2px dashed var(--ridrs-accent); }
.we-fields { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; }
.we-fields .we-field { width: 110px; }
.we-fields .we-wide { width: 200px; }
.we-grip { cursor: grab; min-width: 36px; padding: 6px 8px; }
.we-tools { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.we-error { margin: 0; color: var(--ridrs-danger); font-size: 13px; }
.we-drop { min-height: 10px; border-radius: var(--ridrs-radius-sm); }
.we-drop[data-over] { outline: 2px dashed var(--ridrs-accent); min-height: 22px; }
.we-foot { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ridrs-line); }
.we-notice { margin: 0; color: var(--ridrs-text-muted); font-size: 13px; }
`;

export function EditorStyles() {
  return <style>{CSS}</style>;
}
