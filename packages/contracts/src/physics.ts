// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';
import { defineEvent } from './events.ts';
import type { TemporalValue } from './temporal.ts';

/*
 * The physics is one-dimensional and uses SI units throughout: kg, m, s, m/s, m/s², N, W, m²,
 * kg/m³. Times are epoch ms from the injected clock, like everywhere in ridrs. Forces are signed
 * along the direction of travel: a positive resistance opposes forward motion.
 */

/** m/s². Shared so that every resistance plugin uses the same value. */
export const STANDARD_GRAVITY = 9.81;

/** Where a parameter value comes from. Phase 5 has no configuration, so everything is a default. */
export type PhysicsParameterOrigin = 'default';

export interface PhysicsParameter {
  readonly value: number;
  readonly origin: PhysicsParameterOrigin;
}

export interface BicycleParameters {
  /** kg */
  readonly mass: PhysicsParameter;
  /** Tyre rolling-resistance coefficient Crr, dimensionless. */
  readonly rollingResistanceCoefficient: PhysicsParameter;
}

export interface BicycleCapability {
  parameters(): BicycleParameters;
}

export interface RiderParameters {
  /** kg */
  readonly mass: PhysicsParameter;
  /** Drag area of the rider on the bicycle, m². */
  readonly cdA: PhysicsParameter;
}

export interface RiderCapability {
  parameters(): RiderParameters;
}

export interface ResistanceInput {
  readonly at: number;
  /** m/s, forward only. */
  readonly speed: number;
  /** Total moving mass in kg, computed once by the integrator; providers never add masses. */
  readonly mass: number;
}

export interface ResistanceProvider {
  /** The providing plugin's manifest id. */
  readonly source: string;
  /** N, signed: positive opposes forward motion. */
  force(input: ResistanceInput): number;
}

export interface ResistanceContribution {
  readonly source: string;
  readonly force: number;
}

export interface ResistanceBreakdown {
  /** N, the signed sum of all contributions. */
  readonly total: number;
  /** Sorted by source. */
  readonly contributions: readonly ResistanceContribution[];
}

export interface TotalResistanceCapability {
  evaluate(input: ResistanceInput): ResistanceBreakdown;
}

export interface PowertrainOutput {
  /** The rider power at the asked time, exactly as the temporal data layer answered. */
  readonly riderPower: TemporalValue;
  /** W; 0 when the rider power is unavailable. */
  readonly wheelPower: number;
  readonly efficiency: number;
}

export interface PowertrainCapability {
  wheelPower(at: number): PowertrainOutput;
}

export interface MotionState {
  readonly at: number;
  /** m/s, never negative. */
  readonly speed: number;
  /** m */
  readonly distance: number;
}

export interface MotionResult extends MotionState {
  /** m/s², the effective one after the standstill clamp. */
  readonly acceleration: number;
  /** kg, total moving mass. */
  readonly mass: number;
  readonly riderPower: TemporalValue;
  /** W */
  readonly wheelPower: number;
  /** N */
  readonly driveForce: number;
  readonly resistance: ResistanceBreakdown;
}

export interface MotionCapability {
  /** Standstill at `at`: speed, distance and acceleration 0. */
  initial(at: number): MotionResult;
  /** One fixed step from `previous` to `at`. */
  advance(previous: MotionState, at: number): MotionResult;
}

/**
 * A step failed in a contributor. Carries the failing plugin when the thrower knows it, so the
 * engine can name it; any other exception fails the step too, just without a plugin.
 */
export class PhysicsStepError extends Error {
  override readonly name = 'PhysicsStepError';
  readonly pluginId?: string;

  constructor(message: string, options?: { pluginId?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.pluginId = options?.pluginId;
  }
}

export const physicsBicycleCapability = defineCapability<
  BicycleCapability,
  'single',
  'physics.bicycle'
>('physics.bicycle', { cardinality: 'single' });

export const physicsRiderCapability = defineCapability<RiderCapability, 'single', 'physics.rider'>(
  'physics.rider',
  { cardinality: 'single' },
);

export const physicsResistanceCapability = defineCapability<
  ResistanceProvider,
  'multiple',
  'physics.resistance'
>('physics.resistance', { cardinality: 'multiple' });

export const physicsTotalResistanceCapability = defineCapability<
  TotalResistanceCapability,
  'single',
  'physics.total-resistance'
>('physics.total-resistance', { cardinality: 'single' });

export const physicsPowertrainCapability = defineCapability<
  PowertrainCapability,
  'single',
  'physics.powertrain'
>('physics.powertrain', { cardinality: 'single' });

export const physicsMotionCapability = defineCapability<
  MotionCapability,
  'single',
  'physics.motion'
>('physics.motion', { cardinality: 'single' });

const temporalValueSchema: z.ZodType<TemporalValue> = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    value: z.number(),
    at: z.number(),
    quality: z.enum(['measured', 'interpolated', 'held', 'extrapolated']),
    sourceId: z.string().min(1),
    sourceMeasuredAt: z.number(),
  }),
  z.object({
    status: z.literal('unavailable'),
    at: z.number(),
    reason: z.enum(['no-source', 'disconnected', 'stale', 'out-of-range']),
  }),
]);

// zod numbers reject NaN and ±Infinity.
const finite = z.number();

/** A motion result of one activity session at step `step`. */
export interface PhysicsState extends MotionResult {
  /** The activity session the state belongs to. */
  readonly sessionId: string;
  /** 0 at ride start; `at = startedAt + 10 · step`. */
  readonly step: number;
}

export const physicsStateSchema: z.ZodType<PhysicsState> = z.object({
  sessionId: z.string().min(1),
  step: z.number().int().nonnegative(),
  at: z.number(),
  speed: finite.nonnegative(),
  distance: finite.nonnegative(),
  acceleration: finite,
  mass: finite.positive(),
  riderPower: temporalValueSchema,
  wheelPower: finite,
  driveForce: finite,
  resistance: z.object({
    total: finite,
    contributions: z.array(z.object({ source: z.string().min(1), force: finite })),
  }),
});

/** Interim publication of the simulation state at about 4 Hz of simulation time. */
export const physicsStateEvent = defineEvent('physics.state', physicsStateSchema);
