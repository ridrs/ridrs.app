// SPDX-License-Identifier: AGPL-3.0-or-later

const workouts = (n: number) => `${n} ${n === 1 ? 'workout' : 'workouts'}`;
const routes = (n: number) => `${n} video ${n === 1 ? 'route' : 'routes'}`;

export const en = {
  layerLabel: 'Files dragged onto ridrs',
  reading: (name: string) => `Reading ${name}…`,
  letGoWorkouts: (n: number) => `${workouts(n)} to your workouts`,
  letGoRoutes: (n: number) => `${routes(n)} to your routes`,
  letGo: (parts: readonly string[]) => `Let go to add ${parts.join(' and ')}`,
  alreadyThere: 'Already in your workouts',
  adding: 'Adding…',
  added: (n: number) => `Added ${workouts(n)} to your workouts`,
  importingRoutes: (n: number) => `Importing ${routes(n)}: see Ride › Real video`,
  failed: (n: number) => `${n} could not be added`,
  more: (n: number) => `+ ${n} more`,
  workout: 'Workout',
  videoRoute: 'Video route',
};

export type Messages = typeof en;
