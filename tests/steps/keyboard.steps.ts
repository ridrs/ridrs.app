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

When('I press the key {string}', async function (this: RidrsWorld, key: string) {
  await press(this, key);
});

/** What can take the focus: buttons and other controls with a role, by name. */
function focusableNamed(name: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('button, [tabindex]')].find(
    (element) => !(element as HTMLButtonElement).disabled && nameOf(element) === name,
  );
}

/**
 * Arrow keys alone, as a remote has them: Right towards a control later in reading order, Left
 * towards one before. Left and Right always move the focus, also on a control that takes Up and
 * Down for itself.
 */
When('I move the focus to {string}', async function (this: RidrsWorld, name: string) {
  let target: HTMLElement | undefined;
  await waitFor(
    () => {
      target = focusableNamed(name);
      assert.ok(target, `No control "${name}"`);
    },
    { timeout: 15_000, interval: 100 },
  );
  for (let step = 0; step < 50 && document.activeElement !== target; step += 1) {
    const focused = document.activeElement;
    const before =
      focused &&
      focused !== document.body &&
      target &&
      focused.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING;
    fireEvent.keyDown(keyTarget(), { key: before ? 'ArrowLeft' : 'ArrowRight' });
    await this.settle();
  }
  assert.ok(document.activeElement === target, `The arrows never reached "${name}"`);
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

Then('nothing has the focus', async function (this: RidrsWorld) {
  await waitFor(() => {
    const focused = document.activeElement;
    // Names, not elements: a diff of two DOM nodes does not end.
    assert.ok(focused === document.body, `The focus is on "${focused && nameOf(focused)}"`);
  });
});

Then('the focused control shows the keys {string}', async function (this: RidrsWorld, keys) {
  await waitFor(() => {
    const focused = document.activeElement;
    assert.ok(focused instanceof HTMLElement, 'Nothing has the focus');
    assert.equal(within(focused).getByTestId('keys').textContent, keys);
  });
});

Then('the focus is on the {string} row', async function (this: RidrsWorld, title: string) {
  await waitFor(() => {
    const row = document.activeElement?.closest('[data-testid="device-row"]');
    assert.ok(row instanceof HTMLElement, 'The focus is on no device row');
    assert.equal(within(row).getByTestId('device-title').textContent, title);
  });
});
