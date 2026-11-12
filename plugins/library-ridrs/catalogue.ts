// SPDX-License-Identifier: AGPL-3.0-or-later

import { type LibraryWorkout, type Workout, workoutSchema } from '@ridrs/contracts';
import { workoutMetrics } from '@ridrs/workout';
import dieselAndPunch from './resources/workouts/diesel-and-punch.json' with { type: 'json' };
import gentleWaves from './resources/workouts/gentle-waves.json' with { type: 'json' };
import halfHourTwice from './resources/workouts/half-hour-twice.json' with { type: 'json' };
import heartbreaker4020 from './resources/workouts/heartbreaker-40-20.json' with { type: 'json' };
import hourPowerPeak from './resources/workouts/hour-power-peak.json' with { type: 'json' };
import lactateShuttle from './resources/workouts/lactate-shuttle.json' with { type: 'json' };
import longEndurance2x50 from './resources/workouts/long-endurance-2x50.json' with { type: 'json' };
import oxygenThief from './resources/workouts/oxygen-thief.json' with { type: 'json' };
import racePrimer from './resources/workouts/race-primer.json' with { type: 'json' };
import recoverySpinUps from './resources/workouts/recovery-spin-ups.json' with { type: 'json' };
import sweetSpot3x12 from './resources/workouts/sweet-spot-3x12.json' with { type: 'json' };
import theAggressor from './resources/workouts/the-aggressor.json' with { type: 'json' };
import threshold3x15 from './resources/workouts/threshold-3x15.json' with { type: 'json' };
import tractorDiesel from './resources/workouts/tractor-diesel.json' with { type: 'json' };
import vo2max3015 from './resources/workouts/vo2max-30-15.json' with { type: 'json' };
import vo2max4x4 from './resources/workouts/vo2max-4x4.json' with { type: 'json' };

// Imported as modules, so that the bundler ships them and the WebView needs no file access. A
// test checks that every file of resources/workouts/ is listed here. The order is the order of the
// library: from easy to hard, by kind.
const FILES: readonly unknown[] = [
  recoverySpinUps,
  gentleWaves,
  longEndurance2x50,
  tractorDiesel,
  halfHourTwice,
  sweetSpot3x12,
  dieselAndPunch,
  threshold3x15,
  hourPowerPeak,
  lactateShuttle,
  vo2max4x4,
  oxygenThief,
  vo2max3015,
  heartbreaker4020,
  theAggressor,
  racePrimer,
];

/** The built-in workouts, validated; a file that fails its schema stops the plugin loudly. */
export function catalogue(files: readonly unknown[] = FILES): Workout[] {
  return files.map((file) => workoutSchema.parse(file));
}

export function libraryWorkout(workout: Workout): LibraryWorkout {
  const metrics = workoutMetrics(workout);
  const folder = workout.category ?? workout.focus;
  return {
    id: workout.id,
    name: workout.name,
    ...(workout.description ? { description: workout.description } : {}),
    sport: workout.sport,
    durationSeconds: metrics.durationSeconds,
    ...(metrics.trainingLoad === undefined ? {} : { trainingLoad: Math.round(metrics.trainingLoad) }),
    steps: workout.steps,
    ...(folder ? { folder } : {}),
    workout,
  };
}
