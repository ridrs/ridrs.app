// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then } from '@cucumber/cucumber';
import { within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

/** The custom property by which the activity screen keeps room at the bottom of its HUD. */
const HUD_INSET_BOTTOM = '--ridrs-hud-inset-bottom';

/** The custom property by which it keeps the bottom right corner free for the ride's buttons. */
const HUD_INSET_BOTTOM_RIGHT = '--ridrs-hud-inset-bottom-right';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const px = (value: string) => Number.parseFloat(value);

/** The element that places a button: itself, or the slot container around a contributed one. */
function placed(button: HTMLElement): HTMLElement {
  let element: HTMLElement | null = button;
  while (element && element.style.position !== 'absolute') element = element.parentElement;
  assert.ok(element, `"${button.getAttribute('aria-label')}" is not placed`);
  return element;
}

// happy-dom has no layout: the place and the shape are asserted on the declared styles.
Then(
  "the ride's buttons {string} are round and side by side at the bottom right",
  async function (this: RidrsWorld, labelsCsv: string) {
    const labels = labelsCsv.split(',').map((label) => label.trim());
    const buttons = await Promise.all(
      labels.map((name) => within(ui(this)).findByRole('button', { name })),
    );
    const boxes = buttons.map(placed);
    for (const [index, button] of buttons.entries()) {
      assert.equal(button.style.borderRadius, '50%', `${labels[index]} is round`);
      assert.ok(
        button.style.width !== '' && button.style.width === button.style.height,
        'as wide as high',
      );
      assert.equal(boxes[index]?.style.bottom, boxes[0]?.style.bottom, 'on one line');
      assert.equal(boxes[index]?.style.top, '');
      assert.equal(boxes[index]?.style.left, '');
    }
    assert.equal(px(boxes[0]?.style.bottom ?? ''), 16, 'at the bottom edge');
    // Placed from the right edge: the first named is the farthest from it.
    const rights = boxes.map((box) => px(box.style.right));
    assert.equal(rights.at(-1), 16, 'at the right edge');
    assert.deepEqual(
      [...rights].sort((a, b) => b - a),
      rights,
      `left to right as named: ${rights.join(', ')}`,
    );
  },
);

Then(
  "the screen keeps the bottom right corner of the HUD free for the ride's buttons",
  async function (this: RidrsWorld) {
    const hud = await within(ui(this)).findByTestId('slot-activity-hud');
    const finish = within(ui(this)).getByRole('button', { name: 'Finish ride' });
    const inset = px(hud.style.getPropertyValue(HUD_INSET_BOTTOM_RIGHT));
    assert.ok(
      inset >= px(finish.style.bottom) + px(finish.style.height),
      `${HUD_INSET_BOTTOM_RIGHT} ${inset} does not clear the buttons`,
    );
  },
);

Then(
  'the screen leaves the rest of the bottom of the HUD to the HUD',
  async function (this: RidrsWorld) {
    const hud = await within(ui(this)).findByTestId('slot-activity-hud');
    const inset = px(hud.style.getPropertyValue(HUD_INSET_BOTTOM));
    assert.ok(
      inset <= 16,
      `${HUD_INSET_BOTTOM} ${inset} keeps room for buttons that are not there`,
    );
  },
);
