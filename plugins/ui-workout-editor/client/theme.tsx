// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the editor: the design tokens of the main screen (ADR 0058, 0074), so light and
 * dark follow the app. A workbench screen: pointer and touch first, so the grips and buttons are
 * large enough to hit; the focused control has the focus ring.
 */
const CSS = `
.we-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; max-width: 900px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text, #fff); font: 500 15px system-ui, sans-serif; }
.we-page h1 { margin: 0; font-size: 28px; font-weight: 500; }
.we-page h2 { margin: 0 0 8px; font-size: 15px; color: var(--ridrs-text-muted, #8b9db2); }
.we-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.we-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.we-button { min-height: 36px; padding: 6px 16px; border: 1.5px solid var(--ridrs-line, #1f3447); border-radius: 999px;
  background: var(--ridrs-surface, #0a1520); color: inherit; font: inherit; cursor: pointer; }
.we-button[disabled] { opacity: .45; cursor: default; }
.we-primary { border-color: var(--ridrs-accent, #27c8ff); color: var(--ridrs-accent, #27c8ff); }
.we-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.we-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.we-label { color: var(--ridrs-text-muted, #8b9db2); font-size: 12px; }
.we-page input, .we-page select, .we-page textarea { box-sizing: border-box; min-height: 36px; padding: 6px 10px;
  border: 1.5px solid var(--ridrs-line, #1f3447); border-radius: 8px; background: var(--ridrs-surface, #0a1520);
  color: inherit; font: inherit; min-width: 0; }
.we-page input[aria-invalid="true"] { border-color: var(--ridrs-danger, #ff5a6e); }
.we-numbers { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; }
.we-numbers > div { display: flex; flex-direction: column; gap: 2px; }
.we-numbers dd { margin: 0; font-size: 18px; }
.we-numbers dt { color: var(--ridrs-text-muted, #8b9db2); font-size: 12px; }
.we-hint { color: var(--ridrs-text-muted, #8b9db2); font-size: 13px; margin: 0; }
.we-add { display: flex; flex-wrap: wrap; gap: 8px; }
.we-steps { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.we-steps .we-steps { margin-left: 22px; padding-left: 10px; border-left: 2px solid var(--ridrs-line, #1f3447); margin-top: 6px; }
.we-row { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 0; border-left: 3px solid transparent;
  border-radius: 8px; background: var(--ridrs-surface, #0a1520); }
.we-row[data-selected] { border-left-color: var(--ridrs-accent, #27c8ff); background: var(--ridrs-surface-raised, #12202e); }
.we-row[data-over] { outline: 2px dashed var(--ridrs-accent, #27c8ff); }
.we-fields { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; }
.we-fields .we-field { width: 110px; }
.we-fields .we-wide { width: 200px; }
.we-grip { cursor: grab; min-width: 36px; padding: 6px 8px; }
.we-tools { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.we-error { margin: 0; color: var(--ridrs-danger, #ff5a6e); font-size: 13px; }
.we-drop { min-height: 10px; border-radius: 6px; }
.we-drop[data-over] { outline: 2px dashed var(--ridrs-accent, #27c8ff); min-height: 22px; }
.we-foot { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ridrs-line, #1f3447); }
.we-notice { margin: 0; color: var(--ridrs-text-muted, #8b9db2); font-size: 13px; }
.we-page button:focus-visible, .we-page input:focus-visible, .we-page select:focus-visible, .we-page textarea:focus-visible {
  outline: 2px solid var(--ridrs-focus, #8dff2a); outline-offset: 2px; }
`;

export function EditorStyles() {
  return <style>{CSS}</style>;
}
