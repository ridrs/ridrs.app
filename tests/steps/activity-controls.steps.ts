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

/** The element that places a button: itself, or the slot container around a contributed one. */
function placed(button: HTMLElement): HTMLElement {
  let element: HTMLElement | null = button;
  while (element && element.style.position !== 'absolute') element = element.parentElement;
  assert.ok(element, `"${button.getAttribute('aria-label')}" is not placed`);
  return element;
}

/** `calc(50% - 64px)` gives -64: the offset from the centre. */
function offset(left: string): number {
  const match = /^calc\(50% ([-+]) (\d+(?:\.\d+)?)px\)$/.exec(left);
  assert.ok(match, `"${left}" is not placed from the centre`);
  return (match[1] === '-' ? -1 : 1) * Number(match[2]);
}

// happy-dom has no layout: the place and the shape are asserted on the declared styles.
Then(
  "the ride's buttons {string} are round and side by side at the bottom centre",
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
    }
    const offsets = boxes.map((box) => offset(box.style.left));
    assert.deepEqual(
      [...offsets].sort((a, b) => a - b),
      offsets,
      `left to right as named: ${offsets.join(', ')}`,
    );
    assert.ok((offsets[0] ?? 0) < 0 && (offsets.at(-1) ?? 0) > 0, 'around the centre');
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
