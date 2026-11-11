// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { mountShell } from '@ridrs/ui-shell';
import { waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures/plugins');
/** Where the badge provider fixture counts its mounts, updates and releases. */
const BADGE_LOG = Symbol.for('ridrs.fixture.ui-badge');

interface BadgeLog {
  mounts: number;
  updates: number;
  releases: number;
}

const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function badgeLog(): BadgeLog {
  return (
    ((globalThis as Record<symbol, unknown>)[BADGE_LOG] as BadgeLog | undefined) ?? {
      mounts: 0,
      updates: 0,
      releases: 0,
    }
  );
}

function shown(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the badge consumer to be shown');
  return view.root;
}

function place(world: RidrsWorld): HTMLElement {
  return within(shown(world)).getByTestId('badge-place');
}

Given(
  'the badge fixtures {string} are composed',
  async function (this: RidrsWorld, foldersCsv: string) {
    delete (globalThis as Record<symbol, unknown>)[BADGE_LOG];
    await this.disposeHost();
    for (const folder of foldersCsv.split(',').map((name) => name.trim())) {
      this.extraPluginDirs.push(resolve(FIXTURES_DIR, folder));
    }
    await this.ensureHost().start();
  },
);

When('the badge consumer is shown', function (this: RidrsWorld) {
  assert.ok(this.uiBridge, 'The UI bridge exists only in @ui scenarios');
  const root = document.createElement('div');
  document.body.appendChild(root);
  const dispose = mountShell(root, this.uiBridge, { logger: quietLogger });
  this.uiViews.push({ root, dispose });
});

Then('the badge shows {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    assert.equal(place(this).dataset.available, 'true');
    assert.equal(within(place(this)).getByTestId('test-badge').textContent, text);
  });
});

Then(
  'the badge is unavailable and the consumer shows {string}',
  async function (this: RidrsWorld, text: string) {
    await waitFor(() => {
      assert.equal(place(this).dataset.available, 'false');
      assert.equal(place(this).textContent, text);
    });
  },
);

Then('no badge is shown', async function (this: RidrsWorld) {
  await waitFor(() => assert.equal(within(shown(this)).queryByTestId('test-badge'), null));
});

Then('the badge consumer says {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    assert.equal(within(shown(this)).getByRole('status').textContent, text);
  });
});

Then('the badge itself says {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() => {
    assert.equal(within(place(this)).getByTestId('test-badge-status').textContent, text);
  });
});

for (const [wording, field] of [
  ['mounted', 'mounts'],
  ['updated', 'updates'],
  ['released', 'releases'],
] as const) {
  Then(
    `the badge provider was ${wording} {int} time(s)`,
    async function (this: RidrsWorld, times: number) {
      await waitFor(() => assert.equal(badgeLog()[field], times));
    },
  );
}
