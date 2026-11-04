// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Unsubscribe } from '@ridrs/ui-sdk';
import { tabbable } from 'tabbable';

const FORWARD = new Set(['ArrowDown', 'ArrowRight']);
const BACKWARD = new Set(['ArrowUp', 'ArrowLeft']);
/** Escape and Backspace on a keyboard; the back key of a remote or a WebView. */
const BACK = new Set(['Escape', 'Backspace', 'BrowserBack', 'GoBack']);
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export interface KeyboardNavigationOptions {
  /** Called for Back; without it, Back keys keep their default. */
  readonly back?: () => void;
}

/** Where the caret needs Left, Right and Backspace. */
function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUTS.has(element.type);
  }
  return element instanceof HTMLTextAreaElement || (element as HTMLElement).isContentEditable;
}

/** Elements that use all arrow keys themselves. */
function ownsArrows(element: Element): boolean {
  return (
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && element.type === 'range')
  );
}

/**
 * Makes everything in `root` usable with the arrow keys, Enter and Back (AGENTS.md rule 12): the
 * arrows move the focus through the focusable elements in reading order and stop at the ends,
 * Enter keeps its default (it activates buttons and links), Back keys call `back`. Keys reach the
 * document while nothing has the focus, so it listens there and takes keys from inside `root`
 * and from the page itself. A handler that called `preventDefault` keeps its key.
 */
export function keyboardNavigation(
  root: HTMLElement,
  options: KeyboardNavigationOptions = {},
): Unsubscribe {
  const document = root.ownerDocument;
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !(target instanceof Element) ||
      !(root.contains(target) || target === document.body || target === document.documentElement)
    ) {
      return;
    }
    const inRoot = root.contains(target) && target !== root;
    if (FORWARD.has(event.key) || BACKWARD.has(event.key)) {
      const sideways = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      if (inRoot && (ownsArrows(target) || (sideways && isTextEntry(target)))) {
        return;
      }
      const focusable = tabbable(root);
      const at = inRoot ? focusable.indexOf(target as HTMLElement) : -1;
      const next =
        at < 0
          ? focusable[0]
          : focusable[
              FORWARD.has(event.key) ? Math.min(at + 1, focusable.length - 1) : Math.max(at - 1, 0)
            ];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    } else if (BACK.has(event.key) && options.back) {
      if (event.key === 'Backspace' && inRoot && isTextEntry(target)) {
        return;
      }
      event.preventDefault();
      options.back();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
