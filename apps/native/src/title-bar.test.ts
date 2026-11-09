// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TITLE_BAR_HEIGHT, type WindowPort, windowDragRegion } from './title-bar.ts';

const press = (target: EventTarget, init: MouseEventInit) =>
  target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, ...init }));

describe('windowDragRegion', () => {
  let root: HTMLElement;
  let text: HTMLElement;
  let button: HTMLElement;
  let port: WindowPort;

  beforeEach(() => {
    root = document.createElement('div');
    text = root.appendChild(document.createElement('p'));
    button = root.appendChild(document.createElement('button'));
    button.appendChild(document.createElement('span'));
    document.body.replaceChildren(root);
    port = { startDragging: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}) };
    windowDragRegion(root, port);
  });

  it('drags the window from the top strip, where the title bar was', () => {
    press(text, { clientY: TITLE_BAR_HEIGHT - 1, detail: 1 });
    expect(port.startDragging).toHaveBeenCalledOnce();
  });

  it('zooms the window on a double click in the strip', () => {
    press(text, { clientY: 4, detail: 2 });
    expect(port.toggleMaximize).toHaveBeenCalledOnce();
    expect(port.startDragging).not.toHaveBeenCalled();
  });

  it('leaves presses below the strip, on controls and with other buttons alone', () => {
    press(text, { clientY: TITLE_BAR_HEIGHT, detail: 1 });
    press(button.firstElementChild as Element, { clientY: 4, detail: 1 });
    press(text, { clientY: 4, detail: 1, button: 2 });
    expect(port.startDragging).not.toHaveBeenCalled();
    expect(port.toggleMaximize).not.toHaveBeenCalled();
  });
});
