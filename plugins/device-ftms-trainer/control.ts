// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  TrainerCommand,
  TrainerControl,
  TrainerControlChangedPayload,
  TrainerLoadSample,
  TrainerMode,
} from '@ridrs/contracts';
import {
  NO_FEATURES,
  OP_CODES,
  type PowerRange,
  parseFeatures,
  parsePowerRange,
  parseResponse,
  quantized,
  RESULT_SUCCESS,
  type TrainerFeatures,
} from './control-point.ts';

export const CONTROL_DEFAULTS = Object.freeze({
  /** Simulation parameters at most this often, and only when they change (D5). */
  simulationIntervalMs: 1000,
  /** ERG targets and gear changes at once, but at most 4 per second (D5). */
  immediateIntervalMs: 250,
  /** Without a Supported Power Range: W. */
  powerRange: Object.freeze({ min: 0, max: 2000 }),
  /** Rise over run sent at most; the KICKR CORE itself simulates up to 16 % (ADR 0056). */
  gradientRange: Object.freeze({ min: -0.1, max: 0.2 }),
  /** A failed command of one kind is reported at most this often. */
  failureReportIntervalMs: 10_000,
});

export interface TrainerDevice {
  readonly deviceId: string;
  readonly deviceName: string;
}

/** What the control does to the world: all of it within the turn that decided it. */
export interface TrainerControlOutputs {
  now(): number;
  /** Publishes `trainer.command`, then writes the bytes with response. */
  send(device: TrainerDevice, command: TrainerCommand): void;
  controlChanged(payload: TrainerControlChangedPayload): void;
  failed(message: string, details: Readonly<Record<string, unknown>>): void;
  lost(message: string, details: Readonly<Record<string, unknown>>): void;
}

function sameCommand(a: TrainerCommand | undefined, b: TrainerCommand): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function clamp(value: number, range: { readonly min: number; readonly max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Control of one FTMS trainer (ADR 0056): takes control on every connection when the trainer can
 * be told a target, starts it with the ride, and chooses one output by mode and capability: the
 * ERG target, else the trainer load with the virtual gear (a gear source is there), else the plain
 * load. It never computes physics: it encodes, clamps and rate-limits on the logical clock.
 */
export class FtmsTrainerControl {
  private device: TrainerDevice | undefined;
  private linkUp = false;
  private features: TrainerFeatures = NO_FEATURES;
  private powerRange: PowerRange | undefined;
  private control: TrainerControl | undefined;
  private riding = false;
  private target: number | null = null;
  private load: TrainerLoadSample | undefined;
  /** The mode command sent last, resent after a reconnect. */
  private lastSent: TrainerCommand | undefined;
  private lastSimulationAt = Number.NEGATIVE_INFINITY;
  private lastImmediateAt = Number.NEGATIVE_INFINITY;
  private lastGearRatio: number | undefined;
  private published: string | undefined;
  private readonly failuresReportedAt = new Map<string, number>();

  constructor(private readonly outputs: TrainerControlOutputs) {}

  /** A read of the Feature or the power range characteristic, or why it failed. */
  readResult(characteristicUuid: string, data: Uint8Array | undefined): void {
    if (characteristicUuid === '2acc') {
      this.features = data ? parseFeatures(data) : NO_FEATURES;
    } else if (characteristicUuid === '2ad8') {
      this.powerRange = data ? parsePowerRange(data) : undefined;
    }
  }

  connected(device: TrainerDevice, characteristics: readonly string[]): void {
    this.device = device;
    this.linkUp = true;
    const settable = this.features.simulation || this.features.targetPower;
    if (!settable || !characteristics.includes('2ad9')) {
      this.setControl('unsupported');
      return;
    }
    this.setControl('requested');
    this.outputs.send(device, { kind: 'request-control' });
  }

  /** The link is not up (any state but `connected`). */
  disconnected(): void {
    if (!this.linkUp) {
      return;
    }
    this.linkUp = false;
    const hadControl = this.control === 'granted' || this.control === 'requested';
    this.features = NO_FEATURES;
    this.powerRange = undefined;
    if (hadControl) {
      this.setControl('lost');
      this.outputs.lost(`Lost control of the trainer "${this.device?.deviceName ?? ''}"`, {
        deviceId: this.device?.deviceId,
      });
    }
  }

  /** An indication of the control point. */
  response(data: Uint8Array): void {
    const response = parseResponse(data);
    if (!response) {
      return;
    }
    if (response.result !== RESULT_SUCCESS) {
      this.reportFailure(response.opCode, response.resultName);
    }
    if (response.opCode !== OP_CODES.requestControl || this.control !== 'requested') {
      return;
    }
    if (response.result !== RESULT_SUCCESS) {
      this.setControl('refused');
      return;
    }
    this.setControl('granted');
    if (this.riding) {
      this.start(true);
    }
  }

  /** A write the trainer refused or that never reached it. */
  writeFailed(data: Uint8Array, reason: string): void {
    const opCode = data[0] ?? 0;
    this.reportFailure(opCode, reason);
    if (opCode === OP_CODES.requestControl && this.control === 'requested') {
      this.setControl('refused');
    }
  }

  rideStarted(): void {
    this.riding = true;
    this.load = undefined;
    if (this.control === 'granted') {
      this.start(false);
    }
  }

  rideFinished(): void {
    this.riding = false;
    this.target = null;
    const device = this.device;
    if (this.control === 'granted' && device && this.linkUp && this.features.simulation) {
      // A flat road: out of ERG, nothing to push against, control kept for the next ride.
      const resistance = this.load?.resistance;
      this.sendMode(device, {
        kind: 'simulation',
        windSpeed: 0,
        gradient: 0,
        crr: resistance?.rollingResistanceCoefficient ?? 0,
        cw: resistance?.windResistanceCoefficient ?? 0,
      });
    }
    this.publish();
  }

  targetPower(watts: number | null): void {
    this.target = watts;
    this.update(false);
  }

  /** The newest trainer load of a ride's step batch. */
  loaded(load: TrainerLoadSample | undefined): void {
    if (load) {
      this.load = load;
    }
    this.update(false);
  }

  private start(resend: boolean): void {
    const device = this.device;
    if (!device || !this.linkUp) {
      return;
    }
    this.outputs.send(device, { kind: 'start' });
    if (resend && this.lastSent) {
      this.sendMode(device, this.lastSent);
    }
    this.update(false);
  }

  private mode(): TrainerMode {
    if (this.control !== 'granted') {
      return 'none';
    }
    if (this.target !== null && this.features.targetPower) {
      return 'erg';
    }
    return this.features.simulation ? 'simulation' : 'none';
  }

  private update(force: boolean): void {
    this.publish();
    const device = this.device;
    if (!this.riding || !device || !this.linkUp || this.control !== 'granted') {
      return;
    }
    const now = this.outputs.now();
    const mode = this.mode();
    if (mode === 'erg' && this.target !== null) {
      const range = this.powerRange ?? CONTROL_DEFAULTS.powerRange;
      const command = quantized({ kind: 'target-power', watts: clamp(this.target, range) });
      if (!force && sameCommand(this.lastSent, command)) {
        return;
      }
      if (now - this.lastImmediateAt >= CONTROL_DEFAULTS.immediateIntervalMs) {
        this.lastImmediateAt = now;
        this.sendMode(device, command);
      }
      return;
    }
    if (mode !== 'simulation' || !this.load) {
      return;
    }
    const gear = this.load.virtualGear;
    const load = gear ? this.load.resistanceWithVirtualGear : this.load.resistance;
    const command = quantized({
      kind: 'simulation',
      windSpeed: load.windSpeed,
      gradient: clamp(load.gradient, CONTROL_DEFAULTS.gradientRange),
      crr: load.rollingResistanceCoefficient,
      cw: load.windResistanceCoefficient,
    });
    if (!force && sameCommand(this.lastSent, command)) {
      return;
    }
    const shifted = gear?.ratio !== this.lastGearRatio;
    const fromErg = this.lastSent?.kind !== 'simulation';
    const interval =
      shifted || fromErg ? CONTROL_DEFAULTS.immediateIntervalMs : CONTROL_DEFAULTS.simulationIntervalMs;
    if (!force && now - this.lastSimulationAt < interval) {
      return;
    }
    this.lastSimulationAt = now;
    this.lastGearRatio = gear?.ratio;
    this.sendMode(device, command);
  }

  private sendMode(device: TrainerDevice, command: TrainerCommand): void {
    this.lastSent = command;
    if (command.kind === 'simulation') {
      this.lastSimulationAt = this.outputs.now();
    }
    this.outputs.send(device, command);
  }

  private setControl(control: TrainerControl): void {
    this.control = control;
    this.publish();
  }

  private publish(): void {
    const device = this.device;
    if (!device || this.control === undefined) {
      return;
    }
    const mode = this.mode();
    const payload: TrainerControlChangedPayload = {
      deviceId: device.deviceId,
      mode,
      control: this.control,
      features: { ...this.features },
      ...(mode === 'erg' && this.target !== null ? { targetPower: this.target } : {}),
    };
    const key = JSON.stringify(payload);
    if (key !== this.published) {
      this.published = key;
      this.outputs.controlChanged(payload);
    }
  }

  private reportFailure(opCode: number, reason: string): void {
    const now = this.outputs.now();
    const kind = `0x${opCode.toString(16).padStart(2, '0')}`;
    const last = this.failuresReportedAt.get(kind);
    if (last !== undefined && now - last < CONTROL_DEFAULTS.failureReportIntervalMs) {
      return;
    }
    this.failuresReportedAt.set(kind, now);
    this.outputs.failed(
      `The trainer "${this.device?.deviceName ?? ''}" refused the command ${kind}: ${reason}`,
      { deviceId: this.device?.deviceId, opCode, reason },
    );
  }
}

