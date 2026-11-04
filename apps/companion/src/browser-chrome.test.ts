// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { suppressBrowserChrome } from './browser-chrome.ts';

function dispatch(target: EventTarget, event: Event): boolean {
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent('keydown', { ...init, cancelable: true, bubbles: true });
const menu = (init: MouseEventInit = {}) =>
  new MouseEvent('contextmenu', { ...init, cancelable: true, bubbles: true });

describe('suppressBrowserChrome', () => {
  let root: HTMLElement;
  let text: HTMLElement;
  let field: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    text = root.appendChild(document.createElement('p'));
    field = root.appendChild(document.createElement('input'));
    document.body.replaceChildren(root);
  });

  it('blocks the context menu, except in text fields', () => {
    suppressBrowserChrome(root, { allowInspect: false });
    expect(dispatch(text, menu())).toBe(true);
    expect(dispatch(text, menu({ shiftKey: true }))).toBe(true);
    expect(dispatch(field, menu())).toBe(false);
  });

  it('keeps Shift + right-click for Inspect when allowed', () => {
    suppressBrowserChrome(root, { allowInspect: true });
    expect(dispatch(text, menu())).toBe(true);
    expect(dispatch(text, menu({ shiftKey: true }))).toBe(false);
  });

  it('blocks reload and zoom keys, not other shortcuts', () => {
    suppressBrowserChrome(root, { allowInspect: false });
    expect(dispatch(text, key({ key: 'r', metaKey: true }))).toBe(true);
    expect(dispatch(text, key({ key: 'R', metaKey: true, shiftKey: true }))).toBe(true);
    expect(dispatch(text, key({ key: 'r', ctrlKey: true }))).toBe(true);
    expect(dispatch(text, key({ key: 'F5' }))).toBe(true);
    expect(dispatch(text, key({ key: '=', metaKey: true }))).toBe(true);
    expect(dispatch(text, key({ key: '-', metaKey: true }))).toBe(true);
    expect(dispatch(text, key({ key: '0', metaKey: true }))).toBe(true);
    expect(dispatch(text, key({ key: 'c', metaKey: true }))).toBe(false);
    expect(dispatch(text, key({ key: 'r' }))).toBe(false);
  });

  it('blocks Ctrl + wheel zoom, not scrolling', () => {
    suppressBrowserChrome(root, { allowInspect: false });
    // happy-dom's WheelEvent carries no modifier keys: set ctrlKey as the WebView would.
    const wheel = (ctrlKey: boolean) => {
      const event = new WheelEvent('wheel', { deltaY: 10, cancelable: true, bubbles: true });
      Object.defineProperty(event, 'ctrlKey', { value: ctrlKey });
      return event;
    };
    expect(dispatch(text, wheel(true))).toBe(true);
    expect(dispatch(text, wheel(false))).toBe(false);
  });
});
