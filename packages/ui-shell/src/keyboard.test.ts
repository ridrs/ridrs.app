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

  it('stops listening', () => {
    stop();
    press(first, 'Escape');
    expect(back).not.toHaveBeenCalled();
  });
});
