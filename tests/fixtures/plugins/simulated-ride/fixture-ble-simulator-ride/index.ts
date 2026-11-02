// SPDX-License-Identifier: AGPL-3.0-or-later

import { bleCentralCapability, definePlugin } from '@ridrs/contracts';
import { BleSimulator, type SimulatedPeripheral } from '@ridrs/testing';

const TRAINER_APPEARS_AFTER_MS = 200;
const PACKET_INTERVAL_MS = 250;
const PACKETS_BEFORE_DROP = 4;
const AWAY_MS = 500;
const FIRST_PACKET = '45 00 B4 00 C8 00'; // 200 W, 90 rpm
const SECOND_PACKET = '45 00 B8 00 DC 00'; // 220 W, 92 rpm

const BAND_APPEARS_AFTER_MS = 300;
const BAND_INTERVAL_MS = 1000;
const BAND_NOTIFICATIONS = 16;
const BAND_PACKET = '00 91'; // 145 bpm

/** Set to "off" to ride without a trainer (see README). */
const TRAINER_SWITCH_ENV = 'RIDRS_SIMULATED_RIDE_TRAINER';

/** Steps reach the running fixture through this global handle (see README). */
const CONTROL = Symbol.for('ridrs.fixture.simulated-ride');

interface SimulatedRideControl {
  /** The band stays connected but stops notifying. */
  stopHeartRate(): void;
}

export default definePlugin({
  initialize(ctx) {
    const simulator = new BleSimulator();
    const timers = new Set<NodeJS.Timeout>();
    const later = (fn: () => void, ms: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };

    // The Phase 2 trainer script: appears -> 4 packets -> drops for 500 ms -> packets forever.
    const playTrainer = (trainer: SimulatedPeripheral): void => {
      let connections = 0;
      trainer.onCentralConnected(() => {
        connections += 1;
        if (connections === 1) {
          let sent = 0;
          const tick = (): void => {
            trainer.notifyIndoorBikeData(FIRST_PACKET);
            sent += 1;
            if (sent < PACKETS_BEFORE_DROP) {
              later(tick, PACKET_INTERVAL_MS);
              return;
            }
            trainer.dropConnectionAndRefuseNew();
            later(() => trainer.acceptConnections(), AWAY_MS);
          };
          later(tick, PACKET_INTERVAL_MS);
        } else {
          const tick = (): void => {
            trainer.notifyIndoorBikeData(SECOND_PACKET);
            later(tick, PACKET_INTERVAL_MS);
          };
          later(tick, PACKET_INTERVAL_MS);
        }
      });
    };

    // The band: 145 bpm every second, 16 times or until told to stop, connected throughout.
    let bandStopped = false;
    const playBand = (band: SimulatedPeripheral): void => {
      const stop = band.onCentralConnected(() => {
        stop();
        let sent = 0;
        const tick = (): void => {
          if (bandStopped) {
            return;
          }
          band.notifyHeartRateMeasurement(BAND_PACKET);
          sent += 1;
          if (sent < BAND_NOTIFICATIONS) {
            later(tick, BAND_INTERVAL_MS);
          }
        };
        later(tick, BAND_INTERVAL_MS);
      });
    };

    let started = false;
    simulator.onScanStart(() => {
      if (started) {
        return;
      }
      started = true;
      if (process.env[TRAINER_SWITCH_ENV] !== 'off') {
        later(() => playTrainer(simulator.addFtmsTrainer('SIM KICKR')), TRAINER_APPEARS_AFTER_MS);
      }
      later(() => playBand(simulator.addHeartRateSensor('SIM HRM')), BAND_APPEARS_AFTER_MS);
    });

    const control: SimulatedRideControl = {
      stopHeartRate: () => {
        bandStopped = true;
      },
    };
    (globalThis as Record<symbol, unknown>)[CONTROL] = control;

    ctx.signal.addEventListener(
      'abort',
      () => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        if ((globalThis as Record<symbol, unknown>)[CONTROL] === control) {
          delete (globalThis as Record<symbol, unknown>)[CONTROL];
        }
      },
      { once: true },
    );

    ctx.capabilities.provide(bleCentralCapability, simulator);
  },
});
