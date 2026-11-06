// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  configSnapshotCapability,
  definePlugin,
  metricCadenceCapability,
  type MotionResult,
  type MotionState,
  type PhysicsParameter,
  PhysicsStepError,
  type PluginContext,
  physicsBicycleCapability,
  physicsMotionCapability,
  physicsPowertrainCapability,
  physicsRiderCapability,
  physicsTotalResistanceCapability,
  type RoadSample,
  type SpatialSeriesReader,
  spatialTerrainCapability,
  type TemporalSeriesReader,
  type TemporalValue,
  type TerrainPoint,
} from '@ridrs/contracts';
import {
  driveForce,
  integrate,
  isPedalling,
  isValidGradient,
  VIRTUAL_SPEED_DEFAULTS,
} from './integrator.ts';

/** A ride starts at 0 m on flat asphalt. */
const FLAT_ASPHALT: RoadSample = Object.freeze({
  gradient: 0,
  surface: 'asphalt',
  origin: 'default',
});

interface Terrain {
  readonly reader: SpatialSeriesReader<TerrainPoint>;
  /** The road the last step used: what holds while the reader has nothing. */
  last: RoadSample;
  /** Whether this ride got its first window: the gap before it is expected, not reported. */
  started: boolean;
  /**
   * The newest window at 0 m when the ride started: left from an earlier ride, so it does not
   * count as this ride's first window.
   */
  before?: { readonly sourceId: string; readonly revision: number };
  /** Whether a gap was reported and has not ended yet: one diagnostic per gap. */
  inGap: boolean;
}

const terrains = new WeakMap<PluginContext, Terrain>();

interface Start {
  /** Cadence, when a plugin provides it; without one, power alone starts the ride. */
  readonly cadence: TemporalSeriesReader;
  /** Whether the rider pedalled in this ride: until then the rider stays at rest. */
  rolling: boolean;
  /** Whether the ride has a world, which is ready with its first window of the ride. */
  awaitsWorld: boolean;
}

const starts = new WeakMap<PluginContext, Start>();

function startOf(ctx: PluginContext): Start {
  const start = starts.get(ctx);
  if (!start) {
    throw new Error('virtual speed is not initialized');
  }
  return start;
}

function valueOf(value: TemporalValue): number | undefined {
  return value.status === 'available' ? value.value : undefined;
}

function terrainOf(ctx: PluginContext): Terrain {
  const terrain = terrains.get(ctx);
  if (!terrain) {
    throw new Error('virtual speed is not initialized');
  }
  return terrain;
}

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

/**
 * Reports the start of a gap in the terrain after the ride's first window, once; the road that
 * holds meanwhile is given.
 */
function reportGap(
  ctx: PluginContext,
  terrain: Terrain,
  details: { at: number; distance: number; reason: string; quality?: 'held' },
): void {
  if (!terrain.started || terrain.inGap) {
    return;
  }
  terrain.inGap = true;
  const { gradient, surface } = terrain.last;
  ctx.reportDiagnostic(
    'terrain-preview-missing',
    `No terrain ahead at ${details.distance} m (${details.reason}): holding the gradient ${gradient} on ${surface}`,
    { ...details, gradient, surface },
  );
}

/**
 * The road at `distance`, read from the spatial layer. Until the ride's first window arrives the
 * road is flat asphalt; the landscape publishes it only once it is mounted for the ride, after
 * step 0. Beyond the newest window the reader holds its last sample: used as given, reported as a
 * gap. Without terrain there, the last road holds. An invalid gradient fails the step, naming the
 * source.
 */
function roadAt(ctx: PluginContext, at: number, distance: number): RoadSample {
  const terrain = terrainOf(ctx);
  const read = terrain.reader.valueAt(distance);
  if (read.status === 'unavailable') {
    reportGap(ctx, terrain, { at, distance, reason: read.reason });
    return terrain.last;
  }
  const { gradient, surface } = read.value;
  if (!isValidGradient(gradient)) {
    throw new PhysicsStepError(`Invalid gradient ${gradient} at ${distance} m`, {
      pluginId: read.sourceId,
    });
  }
  terrain.last = { gradient, surface, origin: 'default' };
  const { before } = terrain;
  const fresh =
    before === undefined || read.sourceId !== before.sourceId || read.revision > before.revision;
  if (read.quality !== 'held' && fresh) {
    terrain.started = true;
  }
  if (read.quality === 'held') {
    reportGap(ctx, terrain, { at, distance, reason: 'outside-window', quality: 'held' });
  } else {
    terrain.inGap = false;
  }
  return terrain.last;
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
  const road = roadAt(ctx, at, distance);
  const resistance = capabilities
    .get(physicsTotalResistanceCapability)
    .evaluate({ at, speed, mass, road });
  assertFinite(ctx, 'total resistance', resistance.total);
  return { mass, power, road, resistance };
}

/**
 * The integrator: drive force, acceleration, speed and distance of a virtual rider on the road.
 * Power comes from the new state's time, forces from the previous speed and distance - a step
 * never consumes its own output. The road comes from the spatial layer (`spatial.terrain`), read
 * once per step at the previous distance; whether a world feeds it shows up at run time.
 */
export default definePlugin({
  initialize(ctx) {
    terrains.set(ctx, {
      reader: ctx.spatial.reader(spatialTerrainCapability),
      last: FLAT_ASPHALT,
      started: false,
      inGap: false,
    });
    starts.set(ctx, {
      cadence: ctx.temporal.reader(metricCadenceCapability),
      rolling: false,
      awaitsWorld: false,
    });
    // `minimumDriveSpeed` is v_min of docs/architecture/physics.md.
    ctx.capabilities.provide(configSnapshotCapability, {
      section: ctx.manifest.id,
      snapshot: () => ({ ...VIRTUAL_SPEED_DEFAULTS }),
    });
    ctx.capabilities.provide(physicsMotionCapability, {
      initial(at): MotionResult {
        // A ride starts at 0 m on flat asphalt until its first window; terrain written stays.
        const terrain = terrainOf(ctx);
        terrain.last = FLAT_ASPHALT;
        terrain.started = false;
        terrain.inGap = false;
        startOf(ctx).rolling = false;
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
        // Until the ride's world is ready and the rider pedals, the ride stands still - also on
        // a descent, where gravity alone would start it rolling, and while the rider pedals into
        // a world that still loads. Once it rolls, it rolls on, pedalling or not.
        const start = startOf(ctx);
        const ready = !start.awaitsWorld || terrainOf(ctx).started;
        start.rolling ||=
          ready && isPedalling(valueOf(power.riderPower), valueOf(start.cadence.valueAt(at)));
        if (!start.rolling) {
          return {
            at,
            speed: 0,
            distance: previous.distance,
            acceleration: 0,
            mass,
            riderPower: power.riderPower,
            wheelPower: power.wheelPower,
            driveForce: assertFinite(ctx, 'drive force', driveForce(power.wheelPower, 0)),
            resistance,
            road,
          };
        }
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

  /**
   * A ride with a world waits for that world's first window; what the terrain already holds then
   * is an earlier ride's. Runs in the turn that started the ride, before its step 0.
   */
  start(ctx) {
    ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
      if (payload.state !== 'running' || payload.resumedAt !== undefined) {
        return;
      }
      const terrain = terrainOf(ctx);
      const read = terrain.reader.valueAt(0);
      terrain.before =
        read.status === 'available'
          ? { sourceId: read.sourceId, revision: read.revision }
          : undefined;
      startOf(ctx).awaitsWorld = payload.world !== undefined;
    });
  },
});
