// SPDX-License-Identifier: AGPL-3.0-or-later

import { bleCentralCapability, definePlugin } from '@ridrs/contracts';
import { BleSimulator, type SimulatedPeripheral } from '@ridrs/testing';

const APPEAR_AFTER_MS = 200;
const PACKET_INTERVAL_MS = 250;
const PACKETS_BEFORE_DROP = 4;
const AWAY_MS = 500;
const FIRST_PACKET = '45 00 B4 00 C8 00'; // 200 W, 90 rpm
const SECOND_PACKET_WATTS = 220; // at 92 rpm

/** Zwift Ride keypad packets: nothing held, and the right shift-up button held. */
const KEYPAD_RELEASED = '23 08 ff ff ff ff 0f';
const KEYPAD: Readonly<Record<string, string>> = { 'shift-up-right': '23 08 ff df ff ff 0f' };

/** Steps reach the running fixture through this global handle (Phase 8). */
const CONTROL = Symbol.for('ridrs.fixture.simulated-trainer');

export interface SimulatedTrainerControl {
  /** The trainer: its control point (`ftmsControl`) and every write it received. */
  readonly trainer: () => SimulatedPeripheral | undefined;
  /** The Zwift Ride presses and releases a button. */
  press(button: string): void;
}

/** Indoor Bike Data with power and 92 rpm (cadence in 0.5 rpm). */
function packet(watts: number): Uint8Array {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x45, true);
  view.setUint16(2, 92 * 2, true);
  view.setInt16(4, watts, true);
  return bytes;
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

    // Script: trainer appears -> 4 packets -> drops for 500 ms -> packets forever. Its control
    // point holds an ERG target: then the rider "pedals" exactly that power (Phase 8).
    const play = (trainer: SimulatedPeripheral): void => {
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
            trainer.notifyIndoorBikeData(
              packet(trainer.ftmsControl?.targetPower ?? SECOND_PACKET_WATTS),
            );
            later(tick, PACKET_INTERVAL_MS);
          };
          later(tick, PACKET_INTERVAL_MS);
        }
      });
    };

    let started = false;
    let trainer: SimulatedPeripheral | undefined;
    // The pair: the left controller forwards the right one's buttons, so it presses them.
    const ride = simulator.addZwiftRide('Zwift Ride', {
      peripheralId: 'sim-ride-left',
      side: 'left',
    });
    simulator.addZwiftRide('Zwift Ride', { peripheralId: 'sim-ride-right', side: 'right' });
    simulator.onScanStart(() => {
      if (started) {
        return;
      }
      started = true;
      later(() => {
        trainer = simulator.addFtmsTrainer('SIM KICKR', {
          control: { simulation: true, targetPower: true },
        });
        play(trainer);
      }, APPEAR_AFTER_MS);
    });

    const control: SimulatedTrainerControl = {
      trainer: () => trainer,
      press: (button) => {
        const held = KEYPAD[button];
        if (!held) {
          throw new Error(`The fixture's controller has no "${button}"`);
        }
        ride.notifyZwiftRide(held);
        ride.notifyZwiftRide(KEYPAD_RELEASED);
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
        delete (globalThis as Record<symbol, unknown>)[CONTROL];
      },
      { once: true },
    );

    ctx.capabilities.provide(bleCentralCapability, simulator);
  },
});
