// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Unsubscribe } from '@ridrs/ui-sdk';
import { type FocusableElement, tabbable } from 'tabbable';
import {
  type Direction,
  findNearestSpatial,
  findSpatialCandidate,
  hasSpatialCandidates,
  hasUsableRect,
  type Rect,
  snapshotRect,
} from './spatial-nav.ts';

const DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
const FORWARD = new Set<Direction>(['down', 'right']);
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

/** True when `element` or any ancestor inside `root` is `inert`. */
function isInert(root: HTMLElement, element: Element): boolean {
  let node: Element | null = element;
  while (node) {
    if (node instanceof HTMLElement && (node.inert || node.hasAttribute('inert'))) {
      return true;
    }
    if (node === root) {
      break;
    }
    node = node.parentElement;
  }
  return false;
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

/** Still in `root`, not inert beneath a dialog, and not replaced by a screen shown inside it. */
function isShown(root: HTMLElement, screen: Element): boolean {
  return (
    screen.isConnected &&
    root.contains(screen) &&
    !isInert(root, screen) &&
    !screen.querySelector('[data-screen]')
  );
}

/** Where the focus was last: to go on from there when its element disappears or disables. */
interface LastFocus {
  readonly element: HTMLElement;
  /** Its latest reading-order place among the focusable elements (fallback without layout). */
  index: number;
  /** Its latest visual bounding rect (used for 2D recovery when layout exists). */
  rect: Rect;
  /** Its screen; `null` for an element right in `root`, which has no screens. */
  readonly screen: Element | null;
}

/**
 * Makes everything in `root` usable with the arrow keys, Enter and Back (AGENTS.md rule 12,
 * ADR 0045, ADR 0107): when layout geometry exists, arrow keys move focus in two dimensions
 * (up/down/left/right) across live `tabbable(root)` controls and stop at the edges; in headless
 * DOMs without layout, they fall back to reading order. Enter keeps its default (it activates
 * buttons and links), Back keys call `back`. A handler that called `preventDefault` keeps its key.
 *
 * Dynamic controls appearing, disappearing or becoming disabled never confuse navigation: every
 * keypress queries live `tabbable(root)` and live geometry, and a `MutationObserver` keeps the
 * last focused anchor fresh so recovery continues from where the vanished or disabled control was
 * without ever auto-focusing an unintended neighbour or jumping back to the top.
 */
export function keyboardNavigation(
  root: HTMLElement,
  options: KeyboardNavigationOptions = {},
): Unsubscribe {
  const document = root.ownerDocument;
  const view = document.defaultView;
  let last: LastFocus | undefined;

  const focusables = (): FocusableElement[] =>
    tabbable(root).filter((element) => !isInert(root, element));

  const refreshLast = () => {
    if (!last?.element.isConnected) {
      return;
    }
    const rect = snapshotRect(last.element);
    if (hasUsableRect(rect)) {
      last.rect = rect;
    }
    const index = focusables().indexOf(last.element);
    if (index >= 0) {
      last.index = index;
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof HTMLElement && root.contains(target) && target !== root) {
      const index = focusables().indexOf(target);
      last =
        index < 0
          ? undefined
          : {
              element: target,
              index,
              rect: snapshotRect(target),
              screen: screenOf(root, target),
            };
    }
  };

  const onScroll = () => {
    if (!last?.element.isConnected) {
      return;
    }
    const rect = snapshotRect(last.element);
    if (hasUsableRect(rect)) {
      last.rect = rect;
    }
  };

  const Observer = view?.MutationObserver ?? MutationObserver;
  const observer = new Observer(refreshLast);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'inert', 'tabindex'],
  });

  /** The next element from an element outside `focusable`, or from nothing. */
  const fromOutside = (
    focusable: readonly FocusableElement[],
    from: Element | undefined,
    direction: Direction,
  ): FocusableElement | undefined => {
    const forward = FORWARD.has(direction);
    if (from) {
      // A focusable container (such as a dialog panel with tabindex="-1") steps into its controls.
      const inside = focusable.find((element) => from.contains(element));
      if (inside) {
        return inside;
      }
      const fromRect = snapshotRect(from);
      if (hasUsableRect(fromRect) && hasSpatialCandidates(focusable, from)) {
        return (
          findSpatialCandidate(fromRect, focusable, direction, from) ??
          findNearestSpatial(fromRect, focusable, from)
        );
      }
      const after = focusable.findIndex(
        (element) => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const at = after < 0 ? focusable.length : after;
      return focusable[forward ? Math.min(at, focusable.length - 1) : Math.max(at - 1, 0)];
    }

    const lastGone =
      last !== undefined && (!last.element.isConnected || !focusable.includes(last.element));
    // The focused element disappeared or became disabled/hidden: continue from its place on the same screen.
    if (last && lastGone && (last.screen === null || isShown(root, last.screen))) {
      const lastScreen = last.screen;
      const liveRect = last.element.isConnected ? snapshotRect(last.element) : undefined;
      const anchor = liveRect && hasUsableRect(liveRect) ? liveRect : last.rect;
      const scoped =
        lastScreen !== null
          ? focusable.filter((element) => lastScreen.contains(element))
          : focusable;
      const pool = scoped.length > 0 ? scoped : focusable;
      if (hasUsableRect(anchor) && hasSpatialCandidates(pool)) {
        return findSpatialCandidate(anchor, pool, direction) ?? findNearestSpatial(anchor, pool);
      }
      const at = Math.min(last.index, focusable.length);
      return focusable[forward ? Math.min(at, focusable.length - 1) : Math.max(at - 1, 0)];
    }

    // Another screen took its place: inside a screen that stays around it (beside a menu and
    // actions that keep their place), the arrows start at the new screen's first control.
    const shown = [...root.querySelectorAll('[data-screen]')]
      .filter((screen) => !isInert(root, screen))
      .at(-1);
    if (last && lastGone && shown && shown.parentElement !== root) {
      const first = focusable.find((element) => shown.contains(element));
      if (first) {
        return first;
      }
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
    const direction = DIRECTIONS[event.key];
    if (direction) {
      const sideways = direction === 'left' || direction === 'right';
      if (inRoot && (ownsArrows(target) || (sideways && isTextEntry(target)))) {
        return;
      }
      const focusable = focusables();
      if (focusable.length === 0) {
        return;
      }
      const at = inRoot ? focusable.indexOf(target as HTMLElement) : -1;
      if (at >= 0) {
        const originRect = snapshotRect(target);
        if (hasUsableRect(originRect) && hasSpatialCandidates(focusable, target)) {
          const next = findSpatialCandidate(originRect, focusable, direction, target);
          event.preventDefault();
          next?.focus();
          return;
        }
        const forward = FORWARD.has(direction);
        const next =
          focusable[forward ? Math.min(at + 1, focusable.length - 1) : Math.max(at - 1, 0)];
        if (next) {
          event.preventDefault();
          next.focus();
        }
        return;
      }
      const next = fromOutside(focusable, inRoot ? target : undefined, direction);
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
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('keydown', onKeyDown);
    root.removeEventListener('scroll', onScroll, true);
  };
}
