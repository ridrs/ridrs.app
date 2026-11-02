// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { parsePairingUri } from '@ridrs/contracts';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

function appRoot(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs app UI to be shown');
  return view.root;
}

Given('the ridrs app uses the companion bridge', function (this: RidrsWorld) {
  this.nativeBleTransport = 'bridge';
});

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

Then(
  'the companion is shown as connected to {string}',
  async function (this: RidrsWorld, name: string) {
    await waitFor(() =>
      assert.equal(
        within(appRoot(this)).getByTestId('bridge-status').textContent,
        `Connected to ${name}`,
      ),
    );
  },
);

Then(
  'the app was asked to use the {string} transport',
  async function (this: RidrsWorld, transport: string) {
    await waitFor(() => assert.equal(this.bleTransportRequests.at(-1), transport));
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

Then('the companion status reads {string}', async function (this: RidrsWorld, text: string) {
  await waitFor(() =>
    assert.equal(within(appRoot(this)).getByTestId('bridge-status').textContent, text),
  );
});
