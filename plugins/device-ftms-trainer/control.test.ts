// SPDX-License-Identifier: AGPL-3.0-or-later

import { hexToBytes, type TrainerCommand, type TrainerLoadSample } from '@ridrs/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { FtmsTrainerControl } from './control.ts';

const DEVICE = { deviceId: 'kickr', deviceName: 'KICKR CORE' };

function loadAt(gradient: number, gear?: number): TrainerLoadSample {
  const resistance = {
    gradient,
    rollingResistanceCoefficient: 0.004,
    windResistanceCoefficient: 0.39,
    windSpeed: 0,
  };
  return {
    resistance,
    resistanceWithVirtualGear: { ...resistance, gradient: gradient + (gear ?? 0) / 100 },
    ...(gear === undefined ? {} : { virtualGear: { index: gear, ratio: gear / 5 } }),
  };
}

describe('trainer control', () => {
  let now = 0;
  let sent: TrainerCommand[];
  let control: FtmsTrainerControl;

  const simulations = () => sent.filter((c) => c.kind === 'simulation');

  beforeEach(() => {
    now = 0;
    sent = [];
    control = new FtmsTrainerControl({
      now: () => now,
      send: (_device, command) => sent.push(command),
      controlChanged: () => undefined,
      failed: () => undefined,
      lost: () => undefined,
    });
    control.readResult('2acc', hexToBytes('0240000008200000'));
    control.connected(DEVICE, ['2ad9']);
    control.response(hexToBytes('800001'));
    control.rideStarted();
  });

  it('requests control, then starts the trainer with the ride', () => {
    expect(sent).toEqual([{ kind: 'request-control' }, { kind: 'start' }]);
  });

  it('sends a changing load at most once a second', () => {
    const times: number[] = [];
    for (let step = 0; step <= 200; step += 1) {
      now = step * 50;
      const before = simulations().length;
      control.loaded(loadAt(step % 2 === 0 ? 0 : 0.05));
      if (simulations().length > before) {
        times.push(now);
      }
    }
    // 10 s: at most at 0, 1000, …, 10000 ms; never two within a second.
    expect(times.length).toBeGreaterThanOrEqual(9);
    expect(times.length).toBeLessThanOrEqual(11);
    expect(times.slice(1).every((t, i) => t - (times[i] ?? 0) >= 1000)).toBe(true);
  });

  it('sends an unchanged load once', () => {
    for (let step = 0; step <= 100; step += 1) {
      now = step * 50;
      control.loaded(loadAt(0.05));
    }
    expect(simulations()).toHaveLength(1);
  });

  it('sends a shift at once, at most 4 times a second', () => {
    control.loaded(loadAt(0.05, 12));
    now = 50;
    control.loaded(loadAt(0.05, 13));
    now = 100;
    control.loaded(loadAt(0.05, 14));
    now = 300;
    control.loaded(loadAt(0.05, 14));
    // At 0 and at 300 ms: 50 ms after the first was too soon, the gear of 300 ms went out then.
    expect(simulations().map((c) => c.kind === 'simulation' && c.gradient)).toEqual([0.17, 0.19]);
  });

  it('sends the ERG target clamped, and no load while in ERG', () => {
    control.readResult('2ad8', hexToBytes('3200e8030100'));
    control.targetPower(1500);
    now = 2000;
    control.loaded(loadAt(0.05));
    expect(sent.slice(2)).toEqual([{ kind: 'target-power', watts: 1000 }]);
  });
});
