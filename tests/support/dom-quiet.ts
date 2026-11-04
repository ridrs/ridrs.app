// SPDX-License-Identifier: AGPL-3.0-or-later

/** Quiet for this long, the screen is complete: its slots fill in after it, asynchronously. */
const SETTLED_MS = 100;
const SETTLE_LIMIT_MS = 3000;

/** Resolves once nothing in `root` changed for {@link SETTLED_MS}, or after the limit. */
export function untilQuiet(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, SETTLED_MS);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    quiet = setTimeout(done, SETTLED_MS);
    const limit = setTimeout(done, SETTLE_LIMIT_MS);
  });
}
