// SPDX-License-Identifier: AGPL-3.0-or-later

const EDITABLE = 'input, textarea, [contenteditable]';
const ZOOM_KEYS = new Set(['+', '=', '-', '0']);

/** Options for {@link suppressBrowserChrome}. */
export interface BrowserChromeOptions {
  /** Dev builds: Shift + right-click still opens the WebView menu, for Inspect. */
  allowInspect: boolean;
}

/**
 * Turns off what makes the WebView feel like a browser: its context menu (text fields keep
 * theirs, for copy and paste), reload by ⌘R / Ctrl+R / F5, which would drop the running state,
 * and page zoom by keys, Ctrl + wheel and trackpad pinch.
 */
export function suppressBrowserChrome(root: HTMLElement, options: BrowserChromeOptions): void {
  root.addEventListener('contextmenu', (event) => {
    const target = event.target;
    const editable = target instanceof Element && target.closest(EDITABLE);
    if (!editable && !(options.allowInspect && event.shiftKey)) {
      event.preventDefault();
    }
  });
  root.addEventListener('keydown', (event) => {
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'F5' || (command && (key === 'r' || ZOOM_KEYS.has(key)))) {
      event.preventDefault();
    }
  });
  root.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    },
    { passive: false },
  );
  // WebKit's trackpad pinch.
  root.addEventListener('gesturestart', (event) => event.preventDefault());
}
