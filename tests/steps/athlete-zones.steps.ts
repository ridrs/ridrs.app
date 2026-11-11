// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type AthleteProfile,
  athleteProfileUpdateService,
  DEFAULT_PROVIDER,
} from '@ridrs/contracts';
import { defaultHeartRateZones, defaultPowerZones } from '@ridrs/workout';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { ATHLETE_DOCUMENT, type AthleteDocument } from '../../plugins/profile-local/athlete.ts';
import type { RidrsWorld } from '../support/world.ts';

/** "55, 75, open" as zones: the last, open one has no bound. */
export function zonesOf(text: string): { upTo?: number }[] {
  return text.split(',').map((part) => {
    const value = part.trim();
    return value === 'open' ? {} : { upTo: Number(value) };
  });
}

function boundsOf(zones: readonly { upTo?: number }[] | undefined): string {
  return (zones ?? []).map((zone) => zone.upTo ?? 'open').join(', ');
}

function localProfile(world: RidrsWorld): AthleteProfile {
  const entry = world.ensureHost().getState('athlete.profile').get(DEFAULT_PROVIDER) as
    | { data?: AthleteProfile }
    | undefined;
  assert.ok(entry?.data, 'The profile on this device is published');
  return entry.data;
}

async function update(world: RidrsWorld, change: Partial<AthleteProfile>) {
  const answer = await world.ensureHost().callService(athleteProfileUpdateService.id, {
    key: DEFAULT_PROVIDER,
    ...change,
  });
  assert.deepEqual(answer, { ok: true });
  await world.settle();
}

When(
  'the rider sets the LTHR of the local athlete profile to {int}',
  async function (this: RidrsWorld, lthr: number) {
    await update(this, { lthr });
  },
);

When(
  'the rider sets the local heart rate zones to {string}',
  async function (this: RidrsWorld, bounds: string) {
    await update(this, { heartRateZones: zonesOf(bounds) });
  },
);

When(
  'the rider sets the local power zones to {string}',
  async function (this: RidrsWorld, bounds: string) {
    await update(this, { powerZones: zonesOf(bounds) });
  },
);

When(
  'the rider writes the default zones to the local athlete profile',
  async function (this: RidrsWorld) {
    const { lthr } = localProfile(this);
    await update(this, {
      powerZones: defaultPowerZones(),
      ...(lthr ? { heartRateZones: defaultHeartRateZones(lthr) } : {}),
    });
  },
);

Then(
  'the local athlete profile has {int} power zones with the upper bounds {string}',
  function (this: RidrsWorld, count: number, bounds: string) {
    const zones = localProfile(this).powerZones;
    assert.equal(zones?.length, count);
    assert.equal(boundsOf(zones), bounds);
  },
);

Then(
  'the local athlete profile has {int} heart rate zones with the upper bounds {string}',
  function (this: RidrsWorld, count: number, bounds: string) {
    const zones = localProfile(this).heartRateZones;
    assert.equal(zones?.length, count);
    assert.equal(boundsOf(zones), bounds);
  },
);

Then('the local athlete profile has no heart rate zones', function (this: RidrsWorld) {
  assert.equal(localProfile(this).heartRateZones, undefined);
});

// ---- The Me page -------------------------------------------------------------------------

const ATHLETE_PATH = `config/user/profile-local/${ATHLETE_DOCUMENT.name}.json`;

async function keepAthlete(world: RidrsWorld, values: Omit<AthleteDocument, 'changedAt'>) {
  const text = `${JSON.stringify({ version: ATHLETE_DOCUMENT.version, value: { ...values, changedAt: 1 } })}\n`;
  await world.settingsFiles.write(ATHLETE_PATH, new TextEncoder().encode(text));
}

Given(
  'the athlete profile on this device holds an FTP of {int} W and an LTHR of {int} bpm',
  async function (this: RidrsWorld, ftp: number, lthr: number) {
    await keepAthlete(this, { ftp, lthr });
  },
);

Given(
  'the athlete profile on this device holds an LTHR of {int} bpm only',
  async function (this: RidrsWorld, lthr: number) {
    await keepAthlete(this, { lthr });
  },
);

/** The screen shown: the innermost one. */
function screen(world: RidrsWorld): HTMLElement {
  const view = world.uiViews[0];
  assert.ok(view, 'Expected the ridrs UI to be shown');
  const shown = [...view.root.querySelectorAll<HTMLElement>('[data-screen]')].at(-1);
  assert.ok(shown, 'No screen is shown');
  return shown;
}

function row(world: RidrsWorld, kind: 'power' | 'heart rate', n: number): HTMLElement {
  const id = `${kind === 'power' ? 'power' : 'heartRate'}-zone-${n}`;
  return within(screen(world)).getByTestId(id);
}

When(
  'I set the bound of power zone {int} to {string}',
  async function (this: RidrsWorld, n: number, value: string) {
    const field = await within(screen(this)).findByLabelText(
      new RegExp(`^(Power zone|Leistungszone) ${n} (upper bound|Obergrenze)`),
    );
    fireEvent.change(field, { target: { value } });
    await this.settle();
  },
);

When(
  'I set the bound of heart rate zone {int} to {string}',
  async function (this: RidrsWorld, n: number, value: string) {
    const field = await within(screen(this)).findByLabelText(
      new RegExp(`^Heart rate zone ${n} upper bound`),
    );
    fireEvent.change(field, { target: { value } });
    await this.settle();
  },
);

When(
  'I name power zone {int} {string}',
  async function (this: RidrsWorld, n: number, name: string) {
    const field = await within(screen(this)).findByLabelText(`Power zone ${n} name`);
    fireEvent.change(field, { target: { value: name } });
    await this.settle();
  },
);

Then(
  'power zone {int} reads {string}, {string} and {string}',
  async function (this: RidrsWorld, n: number, name: string, bound: string, watts: string) {
    await waitFor(() => {
      const zone = row(this, 'power', n);
      assert.deepEqual(
        [
          (within(zone).getByLabelText(/name$/) as HTMLInputElement).value,
          (within(zone).getByLabelText(/upper bound/) as HTMLInputElement).value,
          within(zone).queryByTestId(`power-zone-${n}-watts`)?.textContent ?? '',
        ],
        [name, bound, watts.trim()],
      );
    });
  },
);

Then(
  'the last power zone reads {string} and {string}',
  async function (this: RidrsWorld, name: string, bound: string) {
    await waitFor(() => {
      const zones = within(screen(this)).getByTestId('power-zones');
      const last = [...zones.querySelectorAll<HTMLElement>('.me-zone')].at(-1) as HTMLElement;
      assert.equal((within(last).getByLabelText(/name$/) as HTMLInputElement).value, name);
      assert.equal(last.querySelector('.me-zone-open')?.textContent, bound);
    });
  },
);

Then(
  'heart rate zone {int} reads {string} and {string}',
  async function (this: RidrsWorld, n: number, name: string, bound: string) {
    await waitFor(() => {
      const zone = row(this, 'heart rate', n);
      assert.deepEqual(
        [
          (within(zone).getByLabelText(/name$/) as HTMLInputElement).value,
          (within(zone).getByLabelText(/upper bound/) as HTMLInputElement).value,
        ],
        [name, bound],
      );
    });
  },
);

Then('the power zones number {int}', async function (this: RidrsWorld, count: number) {
  await waitFor(() =>
    assert.equal(
      within(screen(this)).getByTestId('power-zones').querySelectorAll('.me-zone').length,
      count,
    ),
  );
});
