// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FullscreenPort, fullscreenCursor } from './fullscreen-cursor.ts';
import { inputModality } from './input-modality.ts';

describe('fullscreenCursor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    document.documentElement.removeAttribute('data-cursor-hidden');
  });

  it('never hides the cursor when windowed', () => {
    const modality = inputModality(document);
    const stop = fullscreenCursor(document, modality, { timeoutMs: 500 });

    document.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }),
    );
    vi.advanceTimersByTime(5000);
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(false);

    stop();
    modality.stop();
  });

  it('hides the cursor in fullscreen after inactivity, resets on movement, hides on keys and restores on exit/blur', () => {
    let listener: ((fullscreen: boolean) => void) | undefined;
    let hostFullscreen = false;
    const setCursorVisible = vi.fn();
    const port: FullscreenPort = {
      isFullscreen: () => hostFullscreen,
      onChange(cb) {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      setCursorVisible,
    };

    const modality = inputModality(document);
    // Start in pointer mode.
    document.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }),
    );
    const stop = fullscreenCursor(document, modality, { port, timeoutMs: 1000 });

    // Enter fullscreen: cursor stays visible until timeout elapses.
    hostFullscreen = true;
    listener?.(true);
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(false);

    // Move mouse at 700 ms: resets timer.
    vi.advanceTimersByTime(700);
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 90, clientY: 50, bubbles: true }),
    );
    vi.advanceTimersByTime(700);
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(false);

    // Idle another 300 ms (1000 ms since last move): cursor hides.
    vi.advanceTimersByTime(300);
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(true);
    expect(setCursorVisible).toHaveBeenLastCalledWith(false);

    // Zero-movement mousemove keeps cursor hidden.
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 90, clientY: 50, bubbles: true }),
    );
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(true);

    // Real pointer movement reveals cursor immediately.
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 140, clientY: 50, bubbles: true }),
    );
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(false);
    expect(setCursorVisible).toHaveBeenLastCalledWith(true);

    // Arrow key hides cursor immediately in fullscreen.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(true);

    // Window blur restores cursor so user keeps their OS cursor in other apps.
    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(false);

    // Window refocus while still in keyboard mode hides cursor again.
    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(true);

    // Leaving fullscreen restores cursor immediately.
    hostFullscreen = false;
    listener?.(false);
    expect(document.documentElement.hasAttribute('data-cursor-hidden')).toBe(false);
    expect(setCursorVisible).toHaveBeenLastCalledWith(true);

    stop();
    modality.stop();
  });
});
