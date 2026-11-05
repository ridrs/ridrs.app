// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Unsubscribe } from '@ridrs/ui-sdk';
import { type FocusableElement, tabbable } from 'tabbable';

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

/** The child of `root` an element is in (the screen, as the shell mounts one), if not itself. */
function screenOf(root: HTMLElement, element: Element): Element | null {
  let node: Element | null = element;
  while (node && node.parentElement !== root) {
    node = node.parentElement;
  }
  return node === element ? null : node;
}

/** Where the focus was last: to go on from there when its element disappears. */
interface LastFocus {
  readonly element: HTMLElement;
  /** Its place among the focusable elements when it got the focus. */
  readonly index: number;
  /** Its screen; `null` for an element right in `root`, which has no screens. */
  readonly screen: Element | null;
}

/**
 * Makes everything in `root` usable with the arrow keys, Enter and Back (AGENTS.md rule 12): the
 * arrows move the focus through the focusable elements in reading order and stop at the ends,
 * Enter keeps its default (it activates buttons and links), Back keys call `back`. Keys reach the
 * document while nothing has the focus, so it listens there and takes keys from inside `root`
 * and from the page itself. A handler that called `preventDefault` keeps its key.
 *
 * The arrows never start over at the top by surprise: when the focused element disappears (a
 * device connected, a list changed), the next arrow goes on from its place on the same screen,
 * and from an element outside the order (`tabindex="-1"`, disabled meanwhile) to its neighbours.
 */
export function keyboardNavigation(
  root: HTMLElement,
  options: KeyboardNavigationOptions = {},
): Unsubscribe {
  const document = root.ownerDocument;
  let last: LastFocus | undefined;

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && root.contains(target) && target !== root) {
      const index = tabbable(root).indexOf(target);
      last = index < 0 ? undefined : { element: target, index, screen: screenOf(root, target) };
    }
  };

  /** The next element from an element that is not among `focusable`, or from nothing. */
  const fromOutside = (
    focusable: readonly FocusableElement[],
    from: Element | undefined,
    forward: boolean,
  ): FocusableElement | undefined => {
    if (from) {
      const after = focusable.findIndex(
        (element) => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const at = after < 0 ? focusable.length : after;
      return focusable[forward ? Math.min(at, focusable.length - 1) : Math.max(at - 1, 0)];
    }
    // The focused element disappeared: go on from its place on the same screen.
    if (
      last &&
      !last.element.isConnected &&
      (last.screen === null || last.screen.parentElement === root)
    ) {
      const at = Math.min(last.index, focusable.length);
      return focusable[forward ? Math.min(at, focusable.length - 1) : Math.max(at - 1, 0)];
    }
    return focusable[0];
  };

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
      const forward = FORWARD.has(event.key);
      const focusable = tabbable(root);
      const at = inRoot ? focusable.indexOf(target as HTMLElement) : -1;
      const next =
        at < 0
          ? fromOutside(focusable, inRoot ? target : undefined, forward)
          : focusable[forward ? Math.min(at + 1, focusable.length - 1) : Math.max(at - 1, 0)];
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
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('keydown', onKeyDown);
  return () => {
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('keydown', onKeyDown);
  };
}
