// SPDX-License-Identifier: AGPL-3.0-or-later

/** Quiet for this long, the screen is complete: its slots fill in after it, asynchronously. */
const SETTLED_MS = 100;
const SETTLE_LIMIT_MS = 3000;

/**
 * The real timers, taken when this module loads: a `@fake-timers` scenario replaces the global
 * ones later, and the quiet of the screen is wall-clock time, not the ride's clock.
 */
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;

/** Resolves once nothing in `root` changed for {@link SETTLED_MS}, or after the limit. */
export function untilQuiet(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof realSetTimeout>;
    const done = () => {
      observer.disconnect();
      realClearTimeout(quiet);
      realClearTimeout(limit);
      resolve();
    };
    const observer = new MutationObserver(() => {
      realClearTimeout(quiet);
      quiet = realSetTimeout(done, SETTLED_MS);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    quiet = realSetTimeout(done, SETTLED_MS);
    const limit = realSetTimeout(done, SETTLE_LIMIT_MS);
  });
}
