// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The look of the details: the design tokens of the main screen (ADR 0058, 0074), so light and
 * dark follow the app; class names carry the plugin's prefix and the Kinetic endings (`-title`,
 * `-label`, `-eyebrow`). The focused step has the focus ring; the selected one, the step the
 * chart highlights, a cyan edge: no element looks focused unless it is (AGENTS.md rule 12).
 */
const CSS = `
.wd-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 18px; max-width: 760px;
  margin: 0 auto; padding: 24px; color: var(--ridrs-text, #fff); font: 500 15px system-ui, sans-serif; }
.wd-page h2 { margin: 0 0 8px; font-size: 15px; color: var(--ridrs-text-muted, #8b9db2); }
.wd-back { align-self: flex-start; padding: 8px 18px; border: 1.5px solid var(--ridrs-line, #1f3447);
  border-radius: 999px; background: var(--ridrs-surface, #0a1520); color: inherit; font: inherit; cursor: pointer; }
.wd-head { display: flex; flex-direction: column; gap: 6px; }
.wd-title { margin: 0; font-size: 30px; font-weight: 500; }
.wd-eyebrow, .wd-byline, .wd-hint { color: var(--ridrs-text-muted, #8b9db2); font-size: 13px; }
.wd-description { margin: 0; white-space: pre-wrap; }
.wd-pairs { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; }
.wd-pairs > div { display: flex; flex-direction: column; gap: 2px; }
.wd-pairs dd { margin: 0; font-size: 18px; }
.wd-label { color: var(--ridrs-text-muted, #8b9db2); font-size: 12px; }
.wd-fallback { margin: 0; padding: 16px; border: 1px dashed var(--ridrs-line, #1f3447);
  border-radius: var(--ridrs-radius, 12px); color: var(--ridrs-text-muted, #8b9db2); }
.wd-steps { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.wd-steps > li { box-sizing: border-box; }
.wd-repeat { display: flex; padding: 6px 12px; color: var(--ridrs-text-muted, #8b9db2); }
.wd-repeat [data-field]:empty { display: none; }
.wd-step { display: grid; grid-template-columns: 10em 9em 1fr auto; gap: 12px; width: 100%; padding: 8px 12px;
  border: 0; border-left: 3px solid transparent; border-radius: 8px; background: var(--ridrs-surface, #0a1520);
  color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wd-step[aria-current="step"] { border-left-color: var(--ridrs-accent, #27c8ff);
  background: var(--ridrs-surface-raised, #12202e); }
.wd-step [data-field="target"] { color: var(--ridrs-accent, #27c8ff); }
.wd-mark { padding: 2px 8px; border: 1px solid var(--ridrs-warn, #ffb62e); border-radius: 999px;
  color: var(--ridrs-warn, #ffb62e); font-size: 12px; }
.wd-back:focus-visible, .wd-step:focus-visible { outline: 2px solid var(--ridrs-focus, #8dff2a); outline-offset: 2px; }
@media (max-width: 560px) {
  .wd-step { grid-template-columns: 1fr auto; }
}
`;

export function DetailsStyles() {
  return <style>{CSS}</style>;
}
