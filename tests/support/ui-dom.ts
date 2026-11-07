// SPDX-License-Identifier: AGPL-3.0-or-later

import { After, AfterAll, Before } from '@cucumber/cucumber';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { configure } from '@testing-library/dom';
import type { RidrsWorld } from './world.ts';

// @ui scenarios render the real shell and UI plugins into a headless DOM (happy-dom), in the same
// process as the host - the way the native app runs them in its WebView. React keeps module-level
// references to the DOM globals, so the DOM is registered once per run; the `ui` profile in
// cucumber.mjs runs these scenarios in their own process, apart from Node-only scenarios.
Before({ tags: '@ui' }, function (this: RidrsWorld) {
  if (!GlobalRegistrator.isRegistered) {
    // happy-dom brings its own WritableStream and TransformStream but keeps Node's ReadableStream:
    // a pipe across the two breaks (zip.js in the media plugins). A WebView has one set; so do we.
    const { WritableStream, TransformStream } = globalThis;
    GlobalRegistrator.register({ url: 'http://localhost/' });
    Object.assign(globalThis, { WritableStream, TransformStream });
    // The simulated trainer plays in real time; its steady state arrives after about two seconds.
    configure({ asyncUtilTimeout: 5000 });
  }
  this.uiEnabled = true;
});

// Defined after the general After hook, so it runs before it: views are unmounted while the DOM
// still exists and React finishes the work their unmounting scheduled.
After({ tags: '@ui' }, async function (this: RidrsWorld) {
  await this.disposeHost();
  await happyDom().waitUntilComplete();
  document.body.replaceChildren();
  // Scenarios may resize the window; the next one starts at happy-dom's default width again.
  happyDom().setViewport({ width: 1024, height: 768 });
});

AfterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

interface HappyDom {
  waitUntilComplete(): Promise<void>;
  setViewport(viewport: { width: number; height: number }): void;
}

function happyDom(): HappyDom {
  return (globalThis as unknown as { happyDOM: HappyDom }).happyDOM;
}
