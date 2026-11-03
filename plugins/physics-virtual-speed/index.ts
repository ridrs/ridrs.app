// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  configSnapshotCapability,
  definePlugin,
  type MotionResult,
  type MotionState,
  type PhysicsParameter,
  PhysicsStepError,
  type PluginContext,
  physicsBicycleCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsRiderCapability,
  physicsRoadCapability,
  physicsTotalResistanceCapability,
  type RoadSample,
} from '@ridrs/contracts';
import { driveForce, integrate, isValidGradient, VIRTUAL_SPEED_DEFAULTS } from './integrator.ts';

function assertFinite(ctx: PluginContext, what: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new PhysicsStepError(`Non-finite ${what}: ${value}`, { pluginId: ctx.manifest.id });
  }
  return value;
}

function massOf(ctx: PluginContext, what: string, parameter: PhysicsParameter): number {
  const mass = assertFinite(ctx, what, parameter.value);
  if (mass <= 0) {
    throw new PhysicsStepError(`Invalid ${what} ${mass}`, { pluginId: ctx.manifest.id });
  }
  return mass;
}

/** The road at `distance`; an invalid sample fails the step, naming the road plugin. */
function roadAt(ctx: PluginContext, distance: number): RoadSample {
  const provider = ctx.capabilities.get(physicsRoadCapability);
  const road = provider.at(distance);
  if (!isValidGradient(road.gradient)) {
    throw new PhysicsStepError(`Invalid gradient ${road.gradient} at ${distance} m`, {
      pluginId: provider.source,
    });
  }
  return road;
}

/**
 * The forces and inputs that act on a state at `at`, moving at `speed` at `distance`. Mass and
 * road are looked up once, so every force uses the same values.
 */
function forcesAt(ctx: PluginContext, at: number, speed: number, distance: number) {
  const capabilities = ctx.capabilities;
  const mass =
    massOf(ctx, 'rider mass', capabilities.get(physicsRiderCapability).parameters().mass) +
    massOf(ctx, 'bicycle mass', capabilities.get(physicsBicycleCapability).parameters().mass);
  const power = capabilities.get(physicsPowertrainCapability).wheelPower(at);
  assertFinite(ctx, 'wheel power', power.wheelPower);
  const road = roadAt(ctx, distance);
  const resistance = capabilities
    .get(physicsTotalResistanceCapability)
    .evaluate({ at, speed, mass, road });
  assertFinite(ctx, 'total resistance', resistance.total);
  return { mass, power, road, resistance };
}

/**
 * The integrator: drive force, acceleration, speed and distance of a virtual rider on the road.
 * Power comes from the new state's time, forces from the previous speed and distance - a step
 * never consumes its own output.
 */
export default definePlugin({
  initialize(ctx) {
    // `minimumDriveSpeed` is v_min of docs/architecture/physics.md.
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ ...VIRTUAL_SPEED_DEFAULTS }),
    });
    ctx.capabilities.provide(physicsMotionCapability, {
      initial(at): MotionResult {
        const { mass, power, road, resistance } = forcesAt(ctx, at, 0, 0);
        return {
          at,
          speed: 0,
          distance: 0,
          acceleration: 0,
          mass,
          riderPower: power.riderPower,
          wheelPower: power.wheelPower,
          driveForce: assertFinite(ctx, 'drive force', driveForce(power.wheelPower, 0)),
          resistance,
          road,
        };
      },

      advance(previous: MotionState, at): MotionResult {
        const { mass, power, road, resistance } = forcesAt(
          ctx,
          at,
          previous.speed,
          previous.distance,
        );
        const next = integrate({
          speed: previous.speed,
          distance: previous.distance,
          mass,
          wheelPower: power.wheelPower,
          resistance: resistance.total,
          // The engine's fixed step; times are whole ms, so this is exact.
          dt: (at - previous.at) / 1000,
        });
        return {
          at,
          speed: assertFinite(ctx, 'speed', next.speed),
          distance: assertFinite(ctx, 'distance', next.distance),
          acceleration: assertFinite(ctx, 'acceleration', next.acceleration),
          mass,
          riderPower: power.riderPower,
          wheelPower: power.wheelPower,
          driveForce: assertFinite(ctx, 'drive force', next.driveForce),
          resistance,
          road,
        };
      },
    });
  },
});
