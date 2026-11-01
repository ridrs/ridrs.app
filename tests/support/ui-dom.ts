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
    GlobalRegistrator.register({ url: 'http://localhost/' });
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
});

AfterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

function happyDom(): { waitUntilComplete(): Promise<void> } {
  return (globalThis as unknown as { happyDOM: { waitUntilComplete(): Promise<void> } }).happyDOM;
}
