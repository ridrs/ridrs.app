// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import * as contracts from './index.ts';

/**
 * Requests and changes on the bus that a replay or a continued ride needs (ADR 0068, ADR 0069,
 * AGENTS.md rule 13): rider input that changes the ride, device data, results of the simulation.
 * Every other request or change is app state (`defineState`) or a service (`defineService`):
 * since ADR 0069 no app event is left on the bus.
 */
const SIMULATION = [
  'activity.finish-requested',
  'activity.pause-requested',
  'activity.resume-requested',
  'activity.start-requested',
  'activity.state-changed',
  'controller.buttons-changed',
  'device.connection-changed',
  'drivetrain.gear-changed',
  'drivetrain.shift-requested',
  'equipment.bicycle-changed',
  'trainer.control-changed',
  'trainer.erg-requested',
];

/** Every event of the contracts, by its export name (topics have an id and a schema too). */
const EVENT_IDS = Object.entries(contracts as Record<string, unknown>)
  .filter(([name]) => name.endsWith('Event'))
  .map(([, value]) => (value as { id?: unknown }).id)
  .filter((id): id is string => typeof id === 'string');

/** What looks like app state or an app command. */
const APP_SHAPED = /(-requested|-changed)$/;

describe('app traffic stays off the simulation bus (ADR 0068, ADR 0069)', () => {
  it('lists only events that exist', () => {
    for (const id of SIMULATION) {
      expect(EVENT_IDS, id).toContain(id);
    }
  });

  it('knows every request and change on the bus as simulation', () => {
    // A new app value is app state, a new app command a service: AGENTS.md rule 13. A new
    // simulation event goes into SIMULATION.
    expect(EVENT_IDS.filter((id) => APP_SHAPED.test(id) && !SIMULATION.includes(id))).toEqual([]);
  });

  it('carries no route, training, recording, export or bridge traffic', () => {
    expect(
      EVENT_IDS.filter((id) => /^(route|training|recording|export|bridge)\./.test(id)),
    ).toEqual([]);
  });

  it('carries of the devices only their connections and their raw data', () => {
    expect(EVENT_IDS.filter((id) => id.startsWith('device.')).sort()).toEqual([
      'device.connection-changed',
      'device.raw-notification',
      'device.raw-read',
      'device.raw-write',
      'device.raw-write-failed',
    ]);
  });
});
