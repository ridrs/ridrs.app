// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { CONTROLLER_BUTTON_EVENT } from '@ridrs/ui-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inputModality } from './input-modality.ts';

describe('inputModality', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('switches automatically between keyboard, controller and pointer while ignoring sub-threshold jitter', () => {
    const handle = inputModality(document);
    stop = handle.stop;
    const changes = vi.fn();
    const pointerMoves = vi.fn();
    handle.onChange(changes);
    handle.onPointerActivity(pointerMoves);

    expect(handle.mode()).toBe('keyboard');
    expect(document.documentElement.dataset.inputMode).toBe('keyboard');

    // First mousemove establishes anchor; tiny jitter does not flip mode.
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 100, clientY: 100, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 102, clientY: 101, bubbles: true }),
    );
    expect(handle.mode()).toBe('keyboard');
    expect(pointerMoves).not.toHaveBeenCalled();

    // Real pointer movement >= 4 px switches to pointer mode.
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 120, clientY: 100, bubbles: true }),
    );
    expect(handle.mode()).toBe('pointer');
    expect(document.documentElement.dataset.inputMode).toBe('pointer');
    expect(changes).toHaveBeenLastCalledWith('pointer');
    expect(pointerMoves).toHaveBeenCalledTimes(1);

    // Arrow key switches back to keyboard mode.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(handle.mode()).toBe('keyboard');
    expect(changes).toHaveBeenLastCalledWith('keyboard');

    // Phantom zero-movement mousemove (e.g. after scroll) keeps keyboard mode.
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 120, clientY: 100, bubbles: true }),
    );
    expect(handle.mode()).toBe('keyboard');

    // Pointer press immediately switches to pointer mode.
    document.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 120, clientY: 100, bubbles: true }),
    );
    expect(handle.mode()).toBe('pointer');

    // Controller button event immediately switches to keyboard mode.
    document.dispatchEvent(
      new CustomEvent(CONTROLLER_BUTTON_EVENT, { detail: { button: 'dpad-down' } }),
    );
    expect(handle.mode()).toBe('keyboard');
  });

  it('ignores modifier shortcuts and cleans up the attribute on stop', () => {
    const handle = inputModality(document);
    stop = handle.stop;
    document.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }),
    );
    expect(handle.mode()).toBe('pointer');

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', metaKey: true, bubbles: true }),
    );
    expect(handle.mode()).toBe('pointer');

    handle.stop();
    stop = undefined;
    expect(document.documentElement.dataset.inputMode).toBeUndefined();
  });
});
