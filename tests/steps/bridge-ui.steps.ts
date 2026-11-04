// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { parsePairingUri } from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function appRoot(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs app UI to be shown');
  return view.root;
}

Then(
  'the companion {string} is offered for pairing',
  async function (this: RidrsWorld, name: string) {
    await within(appRoot(this)).findByLabelText(`Pairing code for ${name}`);
  },
);

When(
  'I enter the pairing code {string} for {string}',
  async function (this: RidrsWorld, code: string, name: string) {
    const input = await within(appRoot(this)).findByLabelText(`Pairing code for ${name}`);
    fireEvent.change(input, { target: { value: code } });
    const form = input.closest('form');
    assert.ok(form, 'Expected the code field to belong to a form');
    fireEvent.click(within(form).getByRole('button', { name: 'Pair' }));
    await this.settle();
  },
);

/** The header of the companion's details in the device setup: its name and its status. */
Then(
  'the companion is shown as connected to {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() => {
      const card = within(appRoot(this)).getByTestId('details-card');
      assert.deepEqual(
        [
          within(card).getByTestId('details-subtitle').textContent,
          within(card).getByTestId('details-status').textContent,
        ],
        [name, 'Connected'],
      );
    });
  },
);

Then(
  'the pairing offers {string} or {string}',
  async function (this: RidrsWorld, first: string, second: string) {
    const pairing = await within(appRoot(this)).findByTestId('bridge-pairing');
    const ways = within(pairing)
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    assert.deepEqual(ways, [first, second]);
  },
);

Then(
  'the code field of {string} takes {int} digits',
  async function (this: RidrsWorld, name: string, digits: number) {
    const input = await within(appRoot(this)).findByLabelText(`Pairing code for ${name}`);
    assert.equal(input.getAttribute('maxlength'), String(digits));
    assert.equal(input.getAttribute('inputmode'), 'numeric');
  },
);

Then('a pairing QR code is shown', async function (this: RidrsWorld) {
  const qr = await within(appRoot(this)).findByTestId('pairing-qr');
  assert.ok(parsePairingUri(qr.getAttribute('data-uri') ?? ''), 'Expected a ridrs pairing URI');
  assert.match(qr.getAttribute('src') ?? '', /^data:image\/svg\+xml/);
});

Then('there is no field for a companion address', function (this: RidrsWorld) {
  assert.equal(within(appRoot(this)).queryByLabelText(/address/i), null);
});
