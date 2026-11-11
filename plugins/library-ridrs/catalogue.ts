// SPDX-License-Identifier: AGPL-3.0-or-later

import { type LibraryWorkout, type Workout, workoutSchema } from '@ridrs/contracts';
import { workoutMetrics } from '@ridrs/workout';
import endurance from './resources/workouts/endurance-75-drills.json' with { type: 'json' };
import microbursts from './resources/workouts/microbursts-30-30.json' with { type: 'json' };
import overUnders from './resources/workouts/over-unders-3x4x3.json' with { type: 'json' };
import sweetSpot from './resources/workouts/sweet-spot-3x12.json' with { type: 'json' };
import vo2max from './resources/workouts/vo2max-5x4.json' with { type: 'json' };

// Imported as modules, so that the bundler ships them and the WebView needs no file access. A
// test checks that every file of resources/workouts/ is listed here.
const FILES: readonly unknown[] = [sweetSpot, vo2max, overUnders, endurance, microbursts];

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
