// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the export: the design tokens of the main screen (ADR 0058, 0074), so light and
 * dark follow the app; class names carry the plugin's prefix and the Kinetic endings (`-title`,
 * `-label`, `-eyebrow`). Warnings are amber, a refusal red; the focused control has the focus ring.
 */
const CSS = `
.we-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; max-width: 640px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text); font: 500 15px var(--ridrs-font-text); }
.we-page h2 { margin: 0 0 8px; font-size: 15px; color: var(--ridrs-text-muted); }
.we-back { align-self: flex-start; padding: 8px 18px; border: 1.5px solid var(--ridrs-line);
  border-radius: var(--ridrs-radius-pill); background: var(--ridrs-surface); color: inherit; font: inherit; cursor: pointer; }
.we-title { margin: 0; font-size: 28px; font-weight: 500; }
.we-label, .we-hint { color: var(--ridrs-text-muted); font-size: 13px; }
.we-formats { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; border: 0; }
.we-format { position: relative; }
.we-format input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.we-format span { display: block; padding: 8px 16px; border: 1.5px solid var(--ridrs-line);
  border-radius: var(--ridrs-radius-pill); background: var(--ridrs-surface); }
.we-format input:checked + span { border-color: var(--ridrs-accent); color: var(--ridrs-accent); }
.we-format input:focus-visible + span { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
.we-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.we-warning { padding: 8px 12px; border-left: 3px solid var(--ridrs-warn); border-radius: var(--ridrs-radius-sm);
  background: var(--ridrs-surface); }
.we-refusal { padding: 12px 16px; border-left: 3px solid var(--ridrs-danger); border-radius: var(--ridrs-radius-sm);
  background: var(--ridrs-surface); }
.we-refusal p { margin: 4px 0 0; }
.we-place { color: var(--ridrs-text-muted); font-size: 13px; }
.we-save { align-self: flex-start; padding: 10px 24px; border: 0; border-radius: var(--ridrs-radius-pill);
  background: var(--ridrs-accent); color: var(--ridrs-on-accent); font: inherit; font-weight: 500; cursor: pointer; }
.we-save:disabled { opacity: .4; cursor: not-allowed; }
.we-back:focus-visible, .we-save:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
`;

export function ExportStyles() {
  return <style>{CSS}</style>;
}
