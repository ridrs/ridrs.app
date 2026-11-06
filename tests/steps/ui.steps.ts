// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Given, Then, When } from '@cucumber/cucumber';
import { mountShell } from '@ridrs/ui-shell';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import type { RidrsWorld } from '../support/world.ts';

const PLUGINS_DIR = resolve(import.meta.dirname, '../../plugins');
const EN_DASH = '–';

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Logs only problems; the shell's warnings and errors are part of what scenarios provoke. */
const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function showUi(world: RidrsWorld): HTMLElement {
  assert.ok(world.uiBridge, 'The UI bridge exists only in @ui scenarios');
  const root = document.createElement('div');
  root.style.position = 'relative';
  document.body.appendChild(root);
  const dispose = mountShell(root, world.uiBridge, { logger: quietLogger });
  world.uiViews.push({ root, dispose });
  return root;
}

function ui(world: RidrsWorld, index = 0): HTMLElement {
  const view = world.uiViews[index];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  return view.root;
}

const slotTestId = (point: string) => `slot-${point.replaceAll('/', '-')}`;

function contributionsIn(slot: HTMLElement): string[] {
  return [...slot.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .map((child) => child.dataset.contribution ?? '');
}

async function screenShown(root: HTMLElement, screenId: string): Promise<void> {
  await waitFor(() => {
    // A framed screen is shown inside its frame: the screens form one chain, the innermost shown.
    const screens = [...root.querySelectorAll<HTMLElement>('[data-screen]')];
    for (const [index, inner] of screens.slice(1).entries()) {
      assert.ok(screens[index]?.contains(inner));
    }
    const shown = screens.at(-1);
    assert.equal(shown?.dataset.screen, screenId);
    // A screen counts as shown once its component rendered something.
    assert.ok(shown?.childElementCount, `Screen "${screenId}" rendered nothing`);
  });
}

async function widget(world: RidrsWorld, kind: string): Promise<HTMLElement> {
  return within(ui(world)).findByTestId(`widget-${kind}`);
}

Given('the ridrs UI is shown', function (this: RidrsWorld) {
  showUi(this);
});

When('I reload the UI', function (this: RidrsWorld) {
  for (const view of this.uiViews.splice(0)) {
    view.dispose();
    view.root.remove();
  }
  showUi(this);
});

When('a second ridrs UI is shown', function (this: RidrsWorld) {
  showUi(this);
});

When('I press {string}', async function (this: RidrsWorld, label: string) {
  const button = await within(ui(this)).findByRole('button', { name: label });
  fireEvent.click(button);
  await this.settle();
});

Given(
  'the plugin directory {string} is added and its plugin {string} is started',
  async function (this: RidrsWorld, relativeDir: string, pluginId: string) {
    // The host has no runtime discovery: compose it again with the extra directory, like an app
    // restart with one more plugin folder.
    await this.disposeHost();
    this.extraPluginDirs.push(resolve(process.cwd(), relativeDir));
    await this.ensureHost().start();
    assert.equal(this.ensureHost().getPluginState(pluginId), 'started');
    showUi(this);
  },
);

Then('the {string} screen is shown', async function (this: RidrsWorld, screenId: string) {
  await screenShown(ui(this), screenId);
});

Then(
  'the {string} screen is shown in the second UI',
  async function (this: RidrsWorld, screenId: string) {
    await screenShown(ui(this, 1), screenId);
  },
);

Then('the page offers a {string} button', async function (this: RidrsWorld, label: string) {
  await within(ui(this)).findByRole('button', { name: label });
});

Then('the page offers no {string} button', async function (this: RidrsWorld, label: string) {
  await this.settle();
  // A message of its own: printing the element found would print the whole page.
  const found = within(ui(this)).queryByRole('button', { name: label });
  assert.ok(found === null, `Expected no "${label}" button`);
});

Then(
  'the slot {string} contains the contribution {string}',
  async function (this: RidrsWorld, point: string, contribution: string) {
    const slot = await within(ui(this)).findByTestId(slotTestId(point));
    await waitFor(() => assert.deepEqual(contributionsIn(slot), [contribution]));
  },
);

Then(
  'the slot {string} contains the contributions {string} in this order',
  async function (this: RidrsWorld, point: string, contributionsCsv: string) {
    const slot = await within(ui(this)).findByTestId(slotTestId(point));
    await waitFor(() => assert.deepEqual(contributionsIn(slot), splitCsv(contributionsCsv)));
  },
);

async function layers(world: RidrsWorld) {
  const root = ui(world);
  // Wait until the whole stack is mounted.
  await within(root).findByTestId('widget-power');
  await within(root).findByTestId('widget-cadence');
  return {
    landscape: within(root).getByTestId('slot-activity-landscape'),
    hud: within(root).getByTestId('slot-activity-hud'),
  };
}

const zIndex = (element: Element) => Number(getComputedStyle(element).zIndex);

Then(
  'the HUD layer covers the same area as the landscape layer',
  async function (this: RidrsWorld) {
    const { landscape, hud } = await layers(this);
    assert.equal(
      hud.parentElement,
      landscape.parentElement,
      'Both layers belong to the same screen',
    );
    for (const element of [landscape, hud]) {
      assert.equal(getComputedStyle(element).position, 'absolute');
      // happy-dom does not expand the `inset` shorthand into computed top/right/bottom/left.
      assert.equal(Number.parseFloat(element.style.inset), 0, `inset is "${element.style.inset}"`);
    }
  },
);

Then('the HUD layer is stacked above the landscape layer', async function (this: RidrsWorld) {
  const { landscape, hud } = await layers(this);
  assert.ok(zIndex(hud) > zIndex(landscape), `z-index ${zIndex(hud)} <= ${zIndex(landscape)}`);
});

Then(
  'pointer events pass through the HUD except on its widgets',
  async function (this: RidrsWorld) {
    const { hud } = await layers(this);
    const hudRoot = within(hud).getByTestId('hud');
    assert.equal(getComputedStyle(hud).pointerEvents, 'none');
    assert.equal(getComputedStyle(hudRoot).pointerEvents, 'none');
    for (const kind of ['power', 'cadence']) {
      assert.equal(
        getComputedStyle(within(hud).getByTestId(`widget-${kind}`)).pointerEvents,
        'auto',
      );
    }
  },
);

Then(
  'the {string} button is stacked above the HUD layer',
  async function (this: RidrsWorld, label: string) {
    const { hud } = await layers(this);
    const button = within(ui(this)).getByRole('button', { name: label });
    assert.equal(
      button.parentElement,
      hud.parentElement,
      'Button and HUD share one stacking context',
    );
    assert.ok(zIndex(button) > zIndex(hud), `z-index ${zIndex(button)} <= ${zIndex(hud)}`);
  },
);

Then(
  'the manifest and the client of {string} mention none of {string}',
  async function (this: RidrsWorld, pluginId: string, namesCsv: string) {
    const manifest = await readFile(resolve(PLUGINS_DIR, pluginId, 'manifest.json'), 'utf8');
    const client = JSON.parse(manifest).ui.client as string;
    const sources = [manifest, await readFile(resolve(PLUGINS_DIR, pluginId, client), 'utf8')];
    for (const name of splitCsv(namesCsv)) {
      assert.ok(
        sources.every((source) => !source.includes(name)),
        `"${pluginId}" mentions "${name}"`,
      );
    }
  },
);

/** How long "eventually" waits: the ui profile runs on real time and sensors take seconds. */
const EVENTUALLY = { timeout: 25_000, interval: 100 } as const;
const EVENTUALLY_STEP = { timeout: 30_000 } as const;

for (const kind of [
  'power',
  'cadence',
  'heart-rate',
  'power-heart-rate-ratio',
  'virtual-speed',
  'virtual-distance',
  'gradient',
]) {
  Then(
    `eventually the ${kind} widget shows {string} {string}`,
    EVENTUALLY_STEP,
    async function (this: RidrsWorld, value: string, unit: string) {
      const element = await widget(this, kind);
      await waitFor(() => {
        assert.equal(element.dataset.status, 'available');
        assert.equal(within(element).getByTestId('value').textContent, value);
        assert.equal(within(element).getByTestId('unit').textContent, unit);
      }, EVENTUALLY);
    },
  );

  Then(
    `eventually the ${kind} widget is unavailable with the reason {string}`,
    EVENTUALLY_STEP,
    async function (this: RidrsWorld, reason: string) {
      const element = await widget(this, kind);
      await waitFor(() => {
        assert.equal(element.dataset.status, 'unavailable');
        assert.equal(within(element).getByTestId('value').textContent, EN_DASH);
        assert.equal(within(element).getByTestId('reason').textContent, reason);
      }, EVENTUALLY);
    },
  );

  Then(
    `the ${kind} widget shows {string} {string}`,
    async function (this: RidrsWorld, value: string, unit: string) {
      const element = await widget(this, kind);
      await waitFor(() => {
        assert.equal(element.dataset.status, 'available');
        assert.equal(within(element).getByTestId('value').textContent, value);
        assert.equal(within(element).getByTestId('unit').textContent, unit);
      });
    },
  );

  Then(
    `the ${kind} widget is unavailable with the reason {string}`,
    async function (this: RidrsWorld, reason: string) {
      const element = await widget(this, kind);
      await waitFor(() => {
        assert.equal(element.dataset.status, 'unavailable');
        assert.equal(within(element).getByTestId('value').textContent, EN_DASH);
        assert.equal(within(element).getByTestId('reason').textContent, reason);
      });
    },
  );

  Then(`the ${kind} widget is unavailable without a reason`, async function (this: RidrsWorld) {
    const element = await widget(this, kind);
    assert.equal(element.dataset.status, 'unavailable');
    assert.equal(within(element).getByTestId('value').textContent, EN_DASH);
    assert.equal(within(element).queryByTestId('reason'), null);
  });

  Then(`the ${kind} widget is still shown`, async function (this: RidrsWorld) {
    await widget(this, kind);
  });

  Then(`the ${kind} widget is no longer shown`, async function (this: RidrsWorld) {
    await waitFor(() => assert.equal(within(ui(this)).queryByTestId(`widget-${kind}`), null));
  });
}

// ---- Phase 5: the physics widgets, on real time ------------------------------------------

/** The number a widget shows, once it shows one in the expected unit. */
function shownNumber(element: HTMLElement, unit: string): number {
  assert.equal(element.dataset.status, 'available');
  assert.equal(within(element).getByTestId('unit').textContent, unit);
  const value = Number(within(element).getByTestId('value').textContent);
  assert.ok(Number.isFinite(value), 'Expected a number');
  return value;
}

for (const kind of ['virtual-speed', 'virtual-distance']) {
  for (const [wording, holds] of [
    ['more than', (shown: number, bound: number) => shown > bound],
    ['at least', (shown: number, bound: number) => shown >= bound],
  ] as const) {
    Then(
      `eventually the ${kind} widget shows ${wording} {string} {string}`,
      EVENTUALLY_STEP,
      async function (this: RidrsWorld, bound: string, unit: string) {
        const element = await widget(this, kind);
        await waitFor(() => {
          const shown = shownNumber(element, unit);
          assert.ok(holds(shown, Number(bound)), `shows ${shown}, expected ${wording} ${bound}`);
        }, EVENTUALLY);
      },
    );
  }

  for (const [wording, holds] of [
    ['rising', (before: number, after: number) => after > before],
    ['falling', (before: number, after: number) => after < before],
  ] as const) {
    Then(`the ${kind} widget keeps ${wording}`, async function (this: RidrsWorld) {
      const element = await widget(this, kind);
      const unit = within(element).getByTestId('unit').textContent ?? '';
      const before = shownNumber(element, unit);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after = shownNumber(element, unit);
      assert.ok(holds(before, after), `${before} ${unit}, then ${after} ${unit} one second later`);
    });
  }
}

/** How far the road has moved (m), as the landscape reports it on its lane markings. */
async function roadPosition(world: RidrsWorld): Promise<number> {
  const markings = await within(ui(world)).findByTestId('lane-markings');
  const position = Number(markings.dataset.position);
  assert.ok(Number.isFinite(position), `position "${markings.dataset.position}"`);
  return position;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Then('the lane markings move', async function (this: RidrsWorld) {
  const before = await roadPosition(this);
  await sleep(500);
  const after = await roadPosition(this);
  assert.ok(after > before, `road at ${before} m, then ${after} m half a second later`);
});

Then('the lane markings stand still', async function (this: RidrsWorld) {
  const before = await roadPosition(this);
  await sleep(500);
  assert.equal(await roadPosition(this), before);
});

Then('the cadence widget is shown after the power widget', async function (this: RidrsWorld) {
  const power = await widget(this, 'power');
  const cadence = await widget(this, 'cadence');
  assert.ok(power.compareDocumentPosition(cadence) & Node.DOCUMENT_POSITION_FOLLOWING);
});

// ---- Phase 4: the simulated-ride fixture ---------------------------------------------------

/** The fixture's switches (see tests/fixtures/plugins/simulated-ride/.../README.md). */
const SIMULATED_RIDE_TRAINER_ENV = 'RIDRS_SIMULATED_RIDE_TRAINER';
const SIMULATED_RIDE_CONTROL = Symbol.for('ridrs.fixture.simulated-ride');

Given('the simulated trainer is switched off', function (this: RidrsWorld) {
  this.setEnv(SIMULATED_RIDE_TRAINER_ENV, 'off');
});

When('the heart-rate band {string} stops sending', function (this: RidrsWorld, _name: string) {
  const control = (globalThis as Record<symbol, unknown>)[SIMULATED_RIDE_CONTROL] as
    | { stopHeartRate(): void }
    | undefined;
  assert.ok(control, 'Expected the simulated-ride fixture to be running');
  control.stopHeartRate();
});
