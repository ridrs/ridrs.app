// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then } from '@cucumber/cucumber';
import { within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

/** The custom property by which the activity screen keeps room at the bottom of its HUD. */
const HUD_INSET_BOTTOM = '--ridrs-hud-inset-bottom';

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
  "the ride's buttons {string} are round and side by side at the top left",
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
      assert.equal(boxes[index]?.style.top, boxes[0]?.style.top, 'on one line');
      assert.equal(boxes[index]?.style.bottom, '');
    }
    // Below the window's own buttons, where the app has them over the page (ui-main-screen).
    assert.match(boxes[0]?.style.top ?? '', /var\(--ridrs-page-top/);
    const lefts = boxes.map((box) => px(box.style.left));
    assert.equal(lefts[0], 16, 'at the left edge');
    assert.deepEqual(
      [...lefts].sort((a, b) => a - b),
      lefts,
      `left to right as named: ${lefts.join(', ')}`,
    );
  },
);

Then('the screen leaves the bottom of the HUD to the HUD', async function (this: RidrsWorld) {
  const hud = await within(ui(this)).findByTestId('slot-activity-hud');
  const inset = px(hud.style.getPropertyValue(HUD_INSET_BOTTOM));
  assert.ok(inset <= 16, `${HUD_INSET_BOTTOM} ${inset} keeps room for buttons that are not there`);
});
