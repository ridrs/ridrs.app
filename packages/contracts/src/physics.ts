// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';
import { defineEvent } from './events.ts';
import type { TemporalValue } from './temporal.ts';
import type { TerrainSurface } from './world.ts';

/*
 * The physics is one-dimensional and uses SI units throughout: kg, m, s, m/s, m/s², N, W, m²,
 * kg/m³. Times are epoch ms from the injected clock, like everywhere in ridrs. Forces are signed
 * along the direction of travel: a positive resistance opposes forward motion.
 */

/** m/s². Shared so that every resistance plugin uses the same value. */
export const STANDARD_GRAVITY = 9.81;

/**
 * What a road surface does to the tyres' rolling resistance coefficient: the bicycle's Crr is the
 * tyre on asphalt, gravel doubles it (ADR 0044). Shared by the rolling resistance and the trainer
 * load, so that both use the same value.
 */
export const SURFACE_ROLLING_FACTORS: Readonly<Record<TerrainSurface, number>> = Object.freeze({
  asphalt: 1,
  gravel: 2,
});

/** Where a parameter value comes from. There is no configuration yet, so everything is a default. */
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

export interface EnvironmentParameters {
  /** kg/m³ */
  readonly airDensity: PhysicsParameter;
}

export interface EnvironmentCapability {
  parameters(): EnvironmentParameters;
}

/**
 * The road under the rider at one position, as the physics read it from the spatial layer
 * (`spatial.terrain`).
 */
export interface RoadSample {
  /** Rise over run, dimensionless: 0.05 is 5 % uphill, -0.05 is 5 % downhill. */
  readonly gradient: number;
  /** What the road is made of; scales the rolling resistance. */
  readonly surface: TerrainSurface;
  readonly origin: PhysicsParameterOrigin;
}

/**
 * State-dependent inputs of one step, computed once by the integrator so that every force uses
 * the same values. Constant model parameters (Crr, CdA, ρ) come from their providers instead.
 */
export interface ResistanceInput {
  readonly at: number;
  /** m/s, forward only. */
  readonly speed: number;
  /** Total moving mass in kg, computed once by the integrator; providers never add masses. */
  readonly mass: number;
  /** The road at the rider's position; providers never query the road themselves. */
  readonly road: RoadSample;
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
  /** The road sample this state's forces used. */
  readonly road: RoadSample;
}

export interface MotionCapability {
  /** Standstill at `at`: speed, distance and acceleration 0. */
  initial(at: number): MotionResult;
  /** One fixed step from `previous` to `at`. */
  advance(previous: MotionState, at: number): MotionResult;
}

/**
 * What a trainer should resist with, as FTMS indoor bike simulation parameters (FTMS 1.0,
 * 4.16.2.18): the trainer computes its brake force from these and its own wheel speed.
 */
export interface TrainerLoad {
  /** Rise over run, 0.05 = 5 %. */
  readonly gradient: number;
  /** Crr · surface factor, dimensionless. */
  readonly rollingResistanceCoefficient: number;
  /** ρ · CdA in kg/m: the air resistance is ½ · cw · v² (the FE-C and FTMS convention). */
  readonly windResistanceCoefficient: number;
  /** m/s; 0, still air, in this phase. */
  readonly windSpeed: number;
}

/** The two loads of one step, for the same simulation time. */
export interface TrainerLoadSample {
  /** The virtual bike's own load, without the virtual gear (`trainerResistance`). */
  readonly resistance: TrainerLoad;
  /**
   * The same load as a trainer without virtual shifting must feel it on its real gear, so that
   * the same cadence feels the virtual gear (`trainerResistanceWithVirtualGear`, ADR 0054). Equal
   * to `resistance` without a gear source.
   */
  readonly resistanceWithVirtualGear: TrainerLoad;
  /** The virtual gear the load used; absent without a gear source. */
  readonly virtualGear?: { readonly index: number; readonly ratio: number };
}

export interface TrainerLoadCapability {
  /** The loads at the state the motion just computed; never changes the motion. */
  load(state: MotionResult): TrainerLoadSample;
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

export const physicsEnvironmentCapability = defineCapability<
  EnvironmentCapability,
  'single',
  'physics.environment'
>('physics.environment', { cardinality: 'single' });

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

export const physicsTrainerLoadCapability = defineCapability<
  TrainerLoadCapability,
  'single',
  'physics.trainer-load'
>('physics.trainer-load', { cardinality: 'single' });

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

const trainerLoadSchema: z.ZodType<TrainerLoad> = z.object({
  gradient: finite,
  rollingResistanceCoefficient: finite.nonnegative(),
  windResistanceCoefficient: finite.nonnegative(),
  windSpeed: finite,
});

const trainerLoadSampleSchema: z.ZodType<TrainerLoadSample> = z.object({
  resistance: trainerLoadSchema,
  resistanceWithVirtualGear: trainerLoadSchema,
  virtualGear: z
    .object({ index: z.number().int().positive(), ratio: finite.positive() })
    .optional(),
});

/** A motion result of one activity session at step `step`. */
export interface PhysicsState extends MotionResult {
  /** The activity session the state belongs to. */
  readonly sessionId: string;
  /** 0 at ride start; `at = startedAt + 10 · step`. */
  readonly step: number;
  /** What a trainer should feel at this step; present when a trainer load is installed. */
  readonly trainerLoad?: TrainerLoadSample;
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
  road: z.object({
    gradient: finite,
    surface: z.enum(['asphalt', 'gravel']),
    origin: z.literal('default'),
  }),
  trainerLoad: trainerLoadSampleSchema.optional(),
});

/** Interim publication of the simulation state at about 4 Hz of simulation time. */
export const physicsStateEvent = defineEvent('physics.state', physicsStateSchema);

/**
 * What a renderer needs of one step: a projection of its `PhysicsState`, values copied, never
 * recomputed.
 */
export interface PhysicsSample {
  readonly step: number;
  /** epoch ms, `startedAt + 10 · step` */
  readonly at: number;
  /** m/s */
  readonly speed: number;
  /** m */
  readonly distance: number;
  /** m/s² */
  readonly acceleration: number;
  /** Rise over run, from the state's road sample. */
  readonly gradient: number;
  /** The state's trainer load, when one is installed. */
  readonly trainerLoad?: TrainerLoadSample;
}

/** Consecutive step samples of one session, ascending: every step goes out in exactly one batch. */
export interface PhysicsStateBatch {
  readonly sessionId: string;
  /** 1–5 entries. */
  readonly samples: readonly PhysicsSample[];
}

const physicsSampleSchema: z.ZodType<PhysicsSample> = z.object({
  step: z.number().int().nonnegative(),
  at: z.number(),
  speed: finite.nonnegative(),
  distance: finite.nonnegative(),
  acceleration: finite,
  gradient: finite,
  trainerLoad: trainerLoadSampleSchema.optional(),
});

export const physicsStateBatchSchema: z.ZodType<PhysicsStateBatch> = z
  .object({
    sessionId: z.string().min(1),
    samples: z.array(physicsSampleSchema).min(1).max(5),
  })
  .refine(({ samples }) => samples.every((sample, n) => sample.step - n === samples[0]?.step), {
    message: 'samples must be consecutive steps in ascending order',
  });

/** Every step's sample, in batches of five steps (50 ms of simulation time), for presentation. */
export const physicsStateBatchEvent = defineEvent('physics.state-batch', physicsStateBatchSchema);
