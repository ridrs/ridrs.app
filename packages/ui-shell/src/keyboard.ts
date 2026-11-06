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

/**
 * The screen an element is in: the innermost `[data-screen]` (a framed screen sits inside its
 * frame), else the child of `root` it is in, if not itself.
 */
function screenOf(root: HTMLElement, element: Element): Element | null {
  const marked = element.parentElement?.closest('[data-screen]');
  if (marked && marked !== root && root.contains(marked)) {
    return marked;
  }
  let node: Element | null = element;
  while (node && node.parentElement !== root) {
    node = node.parentElement;
  }
  return node === element ? null : node;
}

/** Still in `root` and not replaced by a screen shown inside it. */
function isShown(root: HTMLElement, screen: Element): boolean {
  return screen.isConnected && root.contains(screen) && !screen.querySelector('[data-screen]');
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
 * When a screen shown inside another one replaced the focused element, they start at its first.
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
    if (last && !last.element.isConnected && (last.screen === null || isShown(root, last.screen))) {
      const at = Math.min(last.index, focusable.length);
      return focusable[forward ? Math.min(at, focusable.length - 1) : Math.max(at - 1, 0)];
    }
    // Another screen took its place: inside a screen that stays around it (beside a menu and
    // actions that keep their place), the arrows start at the new screen's first control.
    const shown = [...root.querySelectorAll('[data-screen]')].at(-1);
    if (last && !last.element.isConnected && shown && shown.parentElement !== root) {
      const first = focusable.find((element) => shown.contains(element));
      if (first) return first;
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
