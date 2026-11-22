// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Unsubscribe } from '@ridrs/ui-sdk';

const INTERACTIVE =
  ':is(button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="spinbutton"], [tabindex]:not([tabindex="-1"])):not(:disabled):not([aria-disabled="true"]):not([data-highlight="delegate"])';

const TEXT_ENTRY =
  ':is(input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"])';

/**
 * Single authoritative interaction stylesheet (ADR 0107, AGENTS.md rule 12):
 * - One highlight style for both keyboard/controller focus and pointer hover.
 * - Focus highlight only in keyboard/controller mode; hover highlight only in pointer mode while
 *   the cursor is visible. Text fields keep their focus ring while actively focused for typing.
 * - Fullscreen cursor hiding overrides any plugin or boot.css cursor declaration.
 */
export const INTERACTION_CSS = `
:root {
  --ridrs-highlight-ring: var(--ridrs-focus-ring, 3px solid var(--ridrs-focus, #00f0ff));
  --ridrs-highlight-offset: 2px;
}
:root :focus,
:root :focus-visible {
  outline: none;
}
:root ${TEXT_ENTRY}:focus {
  outline: var(--ridrs-highlight-ring);
  outline-offset: var(--ridrs-highlight-offset);
}
:root[data-input-mode="keyboard"] ${INTERACTIVE}:focus {
  outline: var(--ridrs-highlight-ring);
  outline-offset: var(--ridrs-highlight-offset);
}
:root[data-input-mode="pointer"]:not([data-cursor-hidden]) ${INTERACTIVE}:hover {
  outline: var(--ridrs-highlight-ring);
  outline-offset: var(--ridrs-highlight-offset);
}
:root[data-cursor-hidden],
:root[data-cursor-hidden] * {
  cursor: none !important;
}
`;

const refCounts = new WeakMap<Document, number>();

/** Mounts the shell's unified interaction stylesheet on `document.head`, ref-counted per document. */
export function mountInteractionStyle(document: Document): Unsubscribe {
  const count = refCounts.get(document) ?? 0;
  refCounts.set(document, count + 1);
  if (count === 0 && !document.head.querySelector('style[data-ridrs-interaction]')) {
    const style = document.createElement('style');
    style.dataset.ridrsInteraction = '';
    style.textContent = INTERACTION_CSS;
    document.head.append(style);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const next = (refCounts.get(document) ?? 1) - 1;
    if (next <= 0) {
      refCounts.delete(document);
      document.head.querySelector('style[data-ridrs-interaction]')?.remove();
    } else {
      refCounts.set(document, next);
    }
  };
}
