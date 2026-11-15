// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then } from '@cucumber/cucumber';
import { within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

/** The custom property by which the activity screen keeps the bottom of its HUD free. */
const HUD_INSET_BOTTOM = '--ridrs-hud-inset-bottom';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const px = (value: string) => Number.parseFloat(value);

// happy-dom has no layout: the place and the shape are asserted on the declared styles.
Then(
  "the ride's buttons {string} are round and side by side at the bottom centre",
  async function (this: RidrsWorld, labelsCsv: string) {
    const labels = labelsCsv.split(',').map((label) => label.trim());
    const buttons = await Promise.all(
      labels.map((name) => within(ui(this)).findByRole('button', { name })),
    );
    for (const button of buttons) {
      assert.equal(button.style.position, 'absolute');
      assert.equal(button.style.borderRadius, '50%');
      assert.equal(button.style.width, button.style.height, 'as wide as high');
      assert.equal(button.style.bottom, buttons[0]?.style.bottom, 'on one line');
      assert.equal(button.style.top, '');
    }
    const [first, second] = buttons;
    assert.ok(first && second);
    assert.match(first.style.left, /50% -/, `${first.style.left} is not left of the centre`);
    assert.match(second.style.left, /50% \+/, `${second.style.left} is not right of the centre`);
  },
);

Then(
  "the screen keeps the bottom of the HUD free for the ride's buttons",
  async function (this: RidrsWorld) {
    const hud = await within(ui(this)).findByTestId('slot-activity-hud');
    const finish = within(ui(this)).getByRole('button', { name: 'Finish ride' });
    const inset = px(hud.style.getPropertyValue(HUD_INSET_BOTTOM));
    assert.ok(
      inset >= px(finish.style.bottom) + px(finish.style.height),
      `${HUD_INSET_BOTTOM} ${inset} does not clear the buttons`,
    );
  },
);
