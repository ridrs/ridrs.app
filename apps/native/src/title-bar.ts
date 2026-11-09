// SPDX-License-Identifier: AGPL-3.0-or-later

import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * On macOS the window has no title bar of its own (`titleBarStyle: "Overlay"` in
 * tauri.conf.json): the app runs up to the top edge and the close, minimize and zoom buttons sit
 * over it. The strip above the page head (`--ridrs-page-top`, ui-main-screen) stands in for the
 * title bar: pressing it moves the window.
 */
export const TITLE_BAR_HEIGHT = 40;

const CONTROL = 'button, a, input, select, textarea, label, [role="button"], [contenteditable]';

/** The window calls the strip needs; the real one is the Tauri window. */
export interface WindowPort {
  startDragging(): Promise<void>;
  toggleMaximize(): Promise<void>;
}

/** Presses on the top strip move the window, a double click zooms it; controls keep their clicks. */
export function windowDragRegion(root: HTMLElement, port: WindowPort): void {
  root.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.clientY >= TITLE_BAR_HEIGHT) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(CONTROL)) {
      return;
    }
    const done = event.detail === 2 ? port.toggleMaximize() : port.startDragging();
    void done.catch((error: unknown) => console.warn('window drag failed', error));
  });
}

/** Only the macOS desktop app overlays its window buttons; iPadOS also says "Mac" but has touch. */
export function hasOverlayTitleBar(): boolean {
  return /^Mac/.test(navigator.platform) && navigator.maxTouchPoints === 0;
}

/** The strip for the current Tauri window, on macOS only. */
export function enableOverlayTitleBar(root: HTMLElement): void {
  if (hasOverlayTitleBar()) {
    windowDragRegion(root, getCurrentWindow());
  }
}
