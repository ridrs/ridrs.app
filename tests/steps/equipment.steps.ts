// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  type ActivityEquipmentPayload,
  activityEquipmentEvent,
  type DrivetrainGearChangedPayload,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  equipmentBicycleChangedEvent,
  type PhysicsState,
  physicsStateEvent,
  type ShiftMode,
} from '@ridrs/contracts';
import {
  BICYCLE_DOCUMENT,
  type BicycleDocument,
  DEFAULT_BICYCLE,
  gearWithTeeth,
  resolveBicycle,
  specificationOf,
} from '../../plugins/ui-garage/bicycle.ts';
import type { RidrsWorld } from '../support/world.ts';

const DOCUMENT_PATH = `config/user/ui-garage/${BICYCLE_DOCUMENT.name}.json`;

function startGear(chainring: number, sprocket: number): BicycleDocument['startGear'] {
  const gear = gearWithTeeth(specificationOf(DEFAULT_BICYCLE.drivetrain), chainring, sprocket);
  assert.ok(gear, `The drivetrain has no ${chainring} × ${sprocket}`);
  return gear;
}

async function keep(world: RidrsWorld, document: BicycleDocument): Promise<void> {
  const text = `${JSON.stringify({ version: BICYCLE_DOCUMENT.version, value: document })}\n`;
  await world.settingsFiles.write(DOCUMENT_PATH, new TextEncoder().encode(text));
}

async function kept(world: RidrsWorld): Promise<BicycleDocument> {
  const entries = await world.settingsFiles.list('config/user/ui-garage');
  if (!entries.some((entry) => entry.path === DOCUMENT_PATH)) {
    return DEFAULT_BICYCLE;
  }
  const bytes = await world.settingsFiles.read(DOCUMENT_PATH);
  return (JSON.parse(new TextDecoder().decode(bytes)) as { value: BicycleDocument }).value;
}

Given('the garage holds a bicycle of {float} kg', async function (this: RidrsWorld, mass: number) {
  await keep(this, { ...DEFAULT_BICYCLE, mass });
});

Given(
  'the garage holds a bicycle of {float} kg in {string} mode starting in {int} × {int}',
  async function (
    this: RidrsWorld,
    mass: number,
    mode: string,
    chainring: number,
    sprocket: number,
  ) {
    await keep(this, {
      ...DEFAULT_BICYCLE,
      mass,
      shiftMode: mode as ShiftMode,
      startGear: startGear(chainring, sprocket),
    });
  },
);

/** As the garage screen does it: keep the document, then hand the bicycle to the next ride. */
When(
  'the rider changes the bicycle in the garage to {float} kg starting in {int} × {int}',
  async function (this: RidrsWorld, mass: number, chainring: number, sprocket: number) {
    const document = { ...(await kept(this)), mass, startGear: startGear(chainring, sprocket) };
    await keep(this, document);
    this.ensureHost().publishEvent(
      'ui-bridge',
      equipmentBicycleChangedEvent,
      resolveBicycle(document),
    );
    await this.settle();
  },
);

When(
  'the rider asks for a harder gear on the {string} derailleur in the activity screen',
  async function (this: RidrsWorld, derailleur: string) {
    this.ensureHost().publishEvent('ui-bridge', drivetrainShiftRequestedEvent, {
      change: 'up',
      derailleur: derailleur as 'front' | 'rear',
    });
    await this.settle();
  },
);

function payloads<T>(world: RidrsWorld, type: string): T[] {
  return world.tapped.filter((e) => e.type === type).map((e) => e.payload as T);
}

Then('the ride froze a bicycle of {float} kg', function (this: RidrsWorld, mass: number) {
  const frozen = payloads<ActivityEquipmentPayload>(this, activityEquipmentEvent.id).at(-1);
  assert.ok(frozen, 'Expected an "activity.equipment" event');
  assert.equal(frozen.bicycle.mass, mass);
});

Then('the ride froze no bicycle', function (this: RidrsWorld) {
  assert.deepEqual(payloads(this, activityEquipmentEvent.id), []);
});

Then(
  'the latest physics state carries a total mass of {float} kg',
  function (this: RidrsWorld, mass: number) {
    const state = payloads<PhysicsState>(this, physicsStateEvent.id).at(-1);
    assert.ok(state, 'Expected a "physics.state" event');
    assert.equal(state.mass, mass);
  },
);

Then(
  'the latest "drivetrain.gear-changed" event shows {int} × {int}',
  function (this: RidrsWorld, chainring: number, sprocket: number) {
    const latest = payloads<DrivetrainGearChangedPayload>(this, drivetrainGearChangedEvent.id).at(
      -1,
    );
    assert.ok(latest, 'Expected a "drivetrain.gear-changed" event');
    assert.deepEqual(
      { chainring: latest.chainring, sprocket: latest.sprocket },
      { chainring, sprocket },
    );
  },
);
