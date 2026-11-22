// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { type DataTable, Given, Then, When } from '@cucumber/cucumber';
import { waitFor } from '@testing-library/dom';
import { untilQuiet } from '../support/dom-quiet.ts';
import type { RidrsWorld } from '../support/world.ts';
import { splitCsv } from './devices-and-metrics.steps.ts';

function ui(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

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

function controlNamed(root: HTMLElement, name: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('button, [tabindex]')].find(
    (element) => nameOf(element) === name,
  );
  assert.ok(found, `No control named "${name}"`);
  return found;
}

function setFullscreenElement(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => element,
  });
  document.dispatchEvent(new Event('fullscreenchange'));
}

When('I move the pointer to {int}, {int}', async function (this: RidrsWorld, x: number, y: number) {
  await untilQuiet(ui(this));
  const event = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true });
  document.dispatchEvent(event);
  await this.settle();
});

Then('the input mode is {string}', async function (this: RidrsWorld, mode: string) {
  await waitFor(() => {
    assert.equal(document.documentElement.dataset.inputMode, mode);
  });
});

Given('the window is in fullscreen', async function (this: RidrsWorld) {
  await untilQuiet(ui(this));
  setFullscreenElement(document.documentElement);
  await this.settle();
});

When('the window leaves fullscreen', async function (this: RidrsWorld) {
  setFullscreenElement(null);
  await this.settle();
});

When('the cursor inactivity timeout elapses', async function (this: RidrsWorld) {
  // Wait slightly past the default fullscreen cursor hide timeout (2500 ms).
  await new Promise((resolve) => setTimeout(resolve, 2700));
  await this.settle();
});

Then('the pointer cursor is hidden', async function (this: RidrsWorld) {
  await waitFor(() => {
    assert.equal(document.documentElement.hasAttribute('data-cursor-hidden'), true);
  });
});

Then('the pointer cursor is visible', async function (this: RidrsWorld) {
  await waitFor(() => {
    assert.equal(document.documentElement.hasAttribute('data-cursor-hidden'), false);
  });
});

Then(
  'all four ride controls {string} use the unified highlight without inline outline overrides',
  async function (this: RidrsWorld, names: string) {
    const root = ui(this);
    await untilQuiet(root);
    const style = document.head.querySelector('style[data-ridrs-interaction]');
    assert.ok(
      style?.textContent?.includes('data-input-mode="keyboard"'),
      'Missing keyboard highlight rule',
    );
    assert.ok(
      style?.textContent?.includes('data-input-mode="pointer"'),
      'Missing pointer highlight rule',
    );
    for (const name of splitCsv(names)) {
      const control = controlNamed(root, name);
      assert.equal(
        control.style.outline,
        '',
        `"${name}" should not set inline outline when unfocused`,
      );
      control.focus();
      await this.settle();
      assert.equal(
        control.style.outline,
        '',
        `"${name}" should not set inline outline when focused`,
      );
    }
  },
);

Given(
  'the visible controls are laid out in 2D:',
  async function (this: RidrsWorld, table: DataTable) {
    const root = ui(this);
    await untilQuiet(root);
    for (const row of table.hashes()) {
      const control = controlNamed(root, row.name ?? '');
      const left = Number(row.left);
      const top = Number(row.top);
      const width = Number(row.width);
      const height = Number(row.height);
      const rect: DOMRect = {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({
          x: left,
          y: top,
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
        }),
      };
      control.getBoundingClientRect = () => rect;
    }
  },
);

When('the control {string} becomes disabled', async function (this: RidrsWorld, name: string) {
  const control = controlNamed(ui(this), name) as HTMLButtonElement;
  control.disabled = true;
  if (document.activeElement === control) {
    control.blur();
  }
  await this.settle();
});
