// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
  FITNESS_MACHINE_FEATURE_CHARACTERISTIC_UUID,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  SUPPORTED_POWER_RANGE_CHARACTERISTIC_UUID,
} from '@ridrs/contracts';
import type { SimulatedPeripheral } from './ble-simulator.ts';

/** Op codes of the FTMS control point (FTMS 1.0, 4.16.1, table 4.15) the simulator knows. */
export const FTMS_OP_CODES = Object.freeze({
  'Request Control': 0x00,
  Reset: 0x01,
  'Set Target Power': 0x05,
  'Start or Resume': 0x07,
  'Stop or Pause': 0x08,
  'Set Indoor Bike Simulation Parameters': 0x11,
});

/** Result codes of a control point response (FTMS 1.0, 4.16.2.22, table 4.24). */
export const FTMS_RESULT_CODES = Object.freeze({
  Success: 0x01,
  'Op Code not supported': 0x02,
  'Invalid Parameter': 0x03,
  'Operation Failed': 0x04,
  'Control Not Permitted': 0x05,
});

export interface SimulatedFtmsControlOptions {
  /** Target setting bit 13: indoor bike simulation parameters. */
  readonly simulation: boolean;
  /** Target setting bit 3: power target (ERG). */
  readonly targetPower: boolean;
  /** Whether its GATT table has the control point; true by default. */
  readonly controlPoint?: boolean;
  /** The Supported Power Range; 0–2000 W in 1 W steps by default. */
  readonly powerRange?: { readonly min: number; readonly max: number };
}

/** A decoded Set Indoor Bike Simulation Parameters command. */
export interface SimulatedSimulation {
  readonly windSpeed: number;
  readonly gradient: number;
  readonly crr: number;
  readonly cw: number;
}

const FTMS_RESPONSE_CODE = 0x80;

/**
 * The control point of a simulated FTMS trainer: it reports its Feature bits, answers every
 * write with an indication `80 <op code> <result>` (success unless told otherwise), refuses a
 * write while indications are off (as a trainer does: ATT error 0xFD), and keeps what it was told.
 */
export class SimulatedFtmsControlPoint {
  /** The ERG target in force; undefined outside ERG. */
  targetPower: number | undefined;
  /** The simulation parameters in force. */
  simulation: SimulatedSimulation | undefined;
  private readonly answers = new Map<number, number>();
  private controlled = false;
  private features: { simulation: boolean; targetPower: boolean };

  constructor(
    private readonly trainer: SimulatedPeripheral,
    options: SimulatedFtmsControlOptions,
  ) {
    this.features = { simulation: options.simulation, targetPower: options.targetPower };
    const characteristics = [
      INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
      FITNESS_MACHINE_FEATURE_CHARACTERISTIC_UUID,
      SUPPORTED_POWER_RANGE_CHARACTERISTIC_UUID,
      ...(options.controlPoint === false
        ? []
        : [FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID]),
    ];
    trainer.setCharacteristics(
      characteristics.map((characteristicUuid) => ({
        serviceUuid: FTMS_SERVICE_UUID,
        characteristicUuid,
      })),
    );
    this.writeFeatures();
    this.setPowerRange(options.powerRange ?? { min: 0, max: 2000 });
    trainer.onCentralConnected(() => {
      // Control belongs to a connection: a new one has to ask again.
      this.controlled = false;
    });
    trainer.onWrite(FTMS_SERVICE_UUID, FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID, (data) =>
      this.written(data),
    );
  }

  /** What it says it can do from now on. */
  setFeatures(features: { readonly simulation: boolean; readonly targetPower: boolean }): void {
    this.features = { ...features };
    this.writeFeatures();
  }

  setPowerRange(range: { readonly min: number; readonly max: number }): void {
    const bytes = new Uint8Array(6);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, range.min, true);
    view.setInt16(2, range.max, true);
    view.setUint16(4, 1, true);
    this.trainer.setValue(FTMS_SERVICE_UUID, SUPPORTED_POWER_RANGE_CHARACTERISTIC_UUID, bytes);
  }

  /** Every later write of the op code is answered with the result code. */
  answer(opCode: number, result: number): void {
    this.answers.set(opCode, result);
  }

  private writeFeatures(): void {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    // Machine features: cadence (bit 1) and power measurement (bit 14).
    view.setUint32(0, (1 << 1) | (1 << 14), true);
    view.setUint32(
      4,
      (this.features.targetPower ? 1 << 3 : 0) | (this.features.simulation ? 1 << 13 : 0),
      true,
    );
    this.trainer.setValue(FTMS_SERVICE_UUID, FITNESS_MACHINE_FEATURE_CHARACTERISTIC_UUID, bytes);
  }

  private written(data: Uint8Array): { readonly error?: string } | undefined {
    if (
      !this.trainer.isSubscribed(
        FTMS_SERVICE_UUID,
        FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
      )
    ) {
      return {
        error:
          'ATT error 0xFD: Client Characteristic Configuration Descriptor Improperly Configured',
      };
    }
    const opCode = data[0] ?? 0xff;
    const result = this.answers.get(opCode) ?? this.resultOf(opCode, data);
    if (result === FTMS_RESULT_CODES.Success) {
      this.apply(opCode, data);
    }
    // The answer is an indication after the write response.
    queueMicrotask(() =>
      this.trainer.notify(
        FTMS_SERVICE_UUID,
        FITNESS_MACHINE_CONTROL_POINT_CHARACTERISTIC_UUID,
        new Uint8Array([FTMS_RESPONSE_CODE, opCode, result]),
      ),
    );
    return undefined;
  }

  private resultOf(opCode: number, data: Uint8Array): number {
    const { Success } = FTMS_RESULT_CODES;
    switch (opCode) {
      case FTMS_OP_CODES['Request Control']:
        return Success;
      case FTMS_OP_CODES['Start or Resume']:
      case FTMS_OP_CODES.Reset:
        return this.controlled ? Success : FTMS_RESULT_CODES['Control Not Permitted'];
      case FTMS_OP_CODES['Set Target Power']:
        if (!this.features.targetPower) {
          return FTMS_RESULT_CODES['Op Code not supported'];
        }
        if (data.length !== 3) {
          return FTMS_RESULT_CODES['Invalid Parameter'];
        }
        return this.controlled ? Success : FTMS_RESULT_CODES['Control Not Permitted'];
      case FTMS_OP_CODES['Set Indoor Bike Simulation Parameters']:
        if (!this.features.simulation) {
          return FTMS_RESULT_CODES['Op Code not supported'];
        }
        if (data.length !== 7) {
          return FTMS_RESULT_CODES['Invalid Parameter'];
        }
        return this.controlled ? Success : FTMS_RESULT_CODES['Control Not Permitted'];
      default:
        return FTMS_RESULT_CODES['Op Code not supported'];
    }
  }

  private apply(opCode: number, data: Uint8Array): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (opCode === FTMS_OP_CODES['Request Control']) {
      this.controlled = true;
    } else if (opCode === FTMS_OP_CODES.Reset) {
      this.controlled = false;
      this.targetPower = undefined;
      this.simulation = undefined;
    } else if (opCode === FTMS_OP_CODES['Set Target Power']) {
      this.targetPower = view.getInt16(1, true);
    } else if (opCode === FTMS_OP_CODES['Set Indoor Bike Simulation Parameters']) {
      this.targetPower = undefined;
      this.simulation = {
        windSpeed: view.getInt16(1, true) / 1000,
        gradient: view.getInt16(3, true) / 10_000,
        crr: view.getUint8(5) / 10_000,
        cw: view.getUint8(6) / 100,
      };
    }
  }
}
