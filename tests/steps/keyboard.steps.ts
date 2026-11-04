// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { untilQuiet } from '../support/dom-quiet.ts';
import type { RidrsWorld } from '../support/world.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

/** Keys go where a browser sends them: to the focused element, or to the page without focus. */
function keyTarget(): Element {
  return document.activeElement ?? document.body;
}

async function press(world: RidrsWorld, key: string): Promise<void> {
  // A rider presses keys on the screen they see, not on one still being assembled.
  await untilQuiet(ui(world));
  fireEvent.keyDown(keyTarget(), { key });
  await world.settle();
}

/** What a screen reader names the element: its label, else its text without decorations. */
function nameOf(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label) {
    return label;
  }
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return (copy.textContent ?? '').trim();
}

When('I press the arrow key {string}', async function (this: RidrsWorld, direction: string) {
  await press(this, `Arrow${direction}`);
});

When('I press Enter', async function (this: RidrsWorld) {
  await untilQuiet(ui(this));
  const focused = keyTarget();
  const notPrevented = fireEvent.keyDown(focused, { key: 'Enter' });
  assert.ok(focused instanceof HTMLButtonElement, `Enter on <${focused.localName}>, not a button`);
  // The browser's default action of Enter on a button.
  if (notPrevented) {
    fireEvent.click(focused);
  }
  await this.settle();
});

When('I press Back', async function (this: RidrsWorld) {
  await press(this, 'Escape');
});

When('I press Backspace', async function (this: RidrsWorld) {
  await press(this, 'Backspace');
});

Then('the focus is on {string}', async function (this: RidrsWorld, name: string) {
  await waitFor(() => {
    const focused = document.activeElement;
    assert.ok(focused && ui(this).contains(focused), 'Nothing in the UI has the focus');
    assert.equal(nameOf(focused), name);
  });
});

Then('the focus is on the {string} row', async function (this: RidrsWorld, title: string) {
  await waitFor(() => {
    const row = document.activeElement?.closest('[data-testid="device-row"]');
    assert.ok(row instanceof HTMLElement, 'The focus is on no device row');
    assert.equal(within(row).getByTestId('device-title').textContent, title);
  });
});
