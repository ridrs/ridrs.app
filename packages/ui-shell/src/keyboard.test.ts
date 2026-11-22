// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyboardNavigation } from './keyboard.ts';

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { ...init, key, cancelable: true, bubbles: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('keyboardNavigation', () => {
  let root: HTMLElement;
  let first: HTMLButtonElement;
  let field: HTMLInputElement;
  let choice: HTMLSelectElement;
  let last: HTMLButtonElement;
  let back: ReturnType<typeof vi.fn<() => void>>;
  let stop: () => void;

  beforeEach(() => {
    root = document.createElement('div');
    first = root.appendChild(document.createElement('button'));
    field = root.appendChild(document.createElement('input'));
    choice = root.appendChild(document.createElement('select'));
    last = root.appendChild(document.createElement('button'));
    document.body.replaceChildren(root);
    back = vi.fn<() => void>();
    stop = keyboardNavigation(root, { back });
  });

  afterEach(() => stop());

  it('moves the focus in reading order and stops at the ends', () => {
    expect(press(document.body, 'ArrowUp')).toBe(true);
    expect(document.activeElement).toBe(first);
    press(first, 'ArrowUp');
    expect(document.activeElement).toBe(first);
    press(first, 'ArrowRight');
    expect(document.activeElement).toBe(field);
    last.focus();
    press(last, 'ArrowDown');
    expect(document.activeElement).toBe(last);
  });

  it('leaves Left, Right and Backspace to a text field, but not Up, Down or Escape', () => {
    field.focus();
    expect(press(field, 'ArrowLeft')).toBe(false);
    expect(press(field, 'Backspace')).toBe(false);
    expect(back).not.toHaveBeenCalled();
    press(field, 'ArrowDown');
    expect(document.activeElement).toBe(choice);
    field.focus();
    press(field, 'Escape');
    expect(back).toHaveBeenCalledOnce();
  });

  it('leaves all arrows to a select', () => {
    choice.focus();
    expect(press(choice, 'ArrowDown')).toBe(false);
    expect(document.activeElement).toBe(choice);
  });

  it('takes Escape, Backspace and the back keys of remotes as Back', () => {
    for (const key of ['Escape', 'Backspace', 'BrowserBack', 'GoBack']) {
      expect(press(first, key)).toBe(true);
    }
    expect(back).toHaveBeenCalledTimes(4);
  });

  it('keeps keys with modifiers, keys already handled and keys from outside', () => {
    expect(press(first, 'ArrowDown', { metaKey: true })).toBe(false);
    const outside = document.body.appendChild(document.createElement('button'));
    expect(press(outside, 'Escape')).toBe(false);
    first.addEventListener('keydown', (event) => event.preventDefault());
    press(first, 'Escape');
    expect(back).not.toHaveBeenCalled();
  });

  it('goes on from the place of a focused element that disappeared', () => {
    const second = root.insertBefore(document.createElement('button'), field);
    second.focus();
    second.remove();
    if (document.activeElement === second) {
      // As a browser does it: the removed element loses the focus.
      (document.activeElement as HTMLElement).blur();
    }
    press(document.body, 'ArrowDown');
    expect(document.activeElement).toBe(field);

    const third = root.insertBefore(document.createElement('button'), field);
    third.focus();
    third.remove();
    third.blur();
    press(document.body, 'ArrowUp');
    expect(document.activeElement).toBe(first);
  });

  it('starts at the top of a new screen', () => {
    const screen = () => {
      const element = document.createElement('div');
      element.append(...['a', 'b', 'c'].map(() => document.createElement('button')));
      return element;
    };
    const before = screen();
    root.replaceChildren(before);
    (before.lastElementChild as HTMLElement).focus();
    const after = screen();
    root.replaceChildren(after);
    (before.lastElementChild as HTMLElement).blur();
    press(document.body, 'ArrowDown');
    expect(document.activeElement).toBe(after.firstElementChild);
  });

  it('starts at the first control of a screen shown inside the one that had the focus', () => {
    const frame = document.createElement('div');
    frame.dataset.screen = 'frame';
    root.replaceChildren(frame);
    const menu = frame.appendChild(document.createElement('button'));
    const home = frame.appendChild(document.createElement('div'));
    const tiles = ['a', 'b', 'c'].map(() => home.appendChild(document.createElement('button')));
    tiles[2]?.focus();
    const framed = document.createElement('div');
    framed.dataset.screen = 'framed';
    framed.append(...['a', 'b', 'c', 'd'].map(() => document.createElement('button')));
    home.replaceWith(framed);
    tiles[2]?.blur();
    press(document.body, 'ArrowDown');
    expect(document.activeElement).toBe(framed.firstElementChild);
    expect(menu.isConnected).toBe(true);
  });

  it('moves from an element outside the order to its neighbours', () => {
    const marker = root.insertBefore(document.createElement('div'), choice);
    marker.tabIndex = -1;
    marker.focus();
    press(marker, 'ArrowDown');
    expect(document.activeElement).toBe(choice);
    marker.focus();
    press(marker, 'ArrowUp');
    expect(document.activeElement).toBe(field);
  });

  it('stops listening', () => {
    stop();
    press(first, 'Escape');
    expect(back).not.toHaveBeenCalled();
  });

  it('navigates in 2D when elements have layout rectangles', () => {
    const rectOf = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      }),
    });
    const [a1, a2, b1, b2] = [
      document.createElement('button'),
      document.createElement('button'),
      document.createElement('button'),
      document.createElement('button'),
    ] as const;
    a1.getBoundingClientRect = () => rectOf(0, 0, 100, 50);
    a2.getBoundingClientRect = () => rectOf(120, 0, 100, 50);
    b1.getBoundingClientRect = () => rectOf(0, 70, 100, 50);
    b2.getBoundingClientRect = () => rectOf(120, 70, 100, 50);
    root.replaceChildren(a1, a2, b1, b2);

    a1.focus();
    press(a1, 'ArrowDown');
    expect(document.activeElement).toBe(b1);
    press(b1, 'ArrowRight');
    expect(document.activeElement).toBe(b2);
    press(b2, 'ArrowUp');
    expect(document.activeElement).toBe(a2);
    press(a2, 'ArrowLeft');
    expect(document.activeElement).toBe(a1);
    // Edge stop: ArrowUp at top stays on a1.
    press(a1, 'ArrowUp');
    expect(document.activeElement).toBe(a1);
  });

  it('keeps place when earlier controls appear before the focused one and it then disappears or disables', async () => {
    const rectOf = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      }),
    });
    const a = document.createElement('button');
    const b = document.createElement('button');
    const c = document.createElement('button');
    a.getBoundingClientRect = () => rectOf(0, 0, 56, 56);
    b.getBoundingClientRect = () => rectOf(72, 0, 56, 56);
    c.getBoundingClientRect = () => rectOf(144, 0, 56, 56);
    root.replaceChildren(a, b, c);

    b.focus();
    // Insert a new button before A while B has focus.
    const extra = document.createElement('button');
    extra.getBoundingClientRect = () => rectOf(0, 200, 120, 56);
    root.prepend(extra);
    await Promise.resolve();

    // B becomes disabled and loses focus; ArrowRight continues to C instead of jumping to extra.
    b.disabled = true;
    b.blur();
    press(document.body, 'ArrowRight');
    expect(document.activeElement).toBe(c);

    // C is removed; ArrowRight finds nothing further right, so recovers to nearest control (A).
    c.remove();
    c.blur();
    press(document.body, 'ArrowRight');
    expect(document.activeElement).toBe(a);
  });

  it('starts inside a newly opened dialog when the screen beneath becomes inert', () => {
    const page = document.createElement('div');
    page.dataset.screen = 'page';
    const pageBtn = page.appendChild(document.createElement('button'));
    const dialog = document.createElement('div');
    const dialogBtn = dialog.appendChild(document.createElement('button'));
    dialog.hidden = true;
    root.replaceChildren(page, dialog);

    pageBtn.focus();
    page.setAttribute('inert', '');
    pageBtn.blur();
    dialog.hidden = false;

    press(document.body, 'ArrowDown');
    expect(document.activeElement).toBe(dialogBtn);
  });
});
