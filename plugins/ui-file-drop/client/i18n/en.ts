// SPDX-License-Identifier: AGPL-3.0-or-later

const workouts = (n: number) => `${n} ${n === 1 ? 'workout' : 'workouts'}`;
const routes = (n: number) => `${n} video ${n === 1 ? 'route' : 'routes'}`;

export const en = {
  layerLabel: 'Files dragged onto ridrs',
  reading: (name: string) => `Reading ${name}…`,
  letGoWorkouts: (n: number) => `${workouts(n)} to your workouts`,
  letGoRoutes: (n: number) => `${routes(n)} to your routes`,
  letGo: (parts: readonly string[]) => `Let go to add ${parts.join(' and ')}`,
  letGoMove: (parts: readonly string[]) => `Let go to move ${parts.join(' and ')}`,
  caption: 'Drop Incyclist video routes and workouts here',
  moveHint: (key: string) => `Hold ${key} to move the files instead of copying them`,
  moving: 'Moving…',
  moved: (n: number) => `Moved ${workouts(n)} to your workouts`,
  alreadyThere: 'Already in your workouts',
  adding: 'Adding…',
  added: (n: number) => `Added ${workouts(n)} to your workouts`,
  importingRoutes: (n: number) => `Importing ${routes(n)}: see Ride › Scenic`,
  failed: (n: number) => `${n} could not be added`,
  letGoInstall: (names: readonly string[]) => `Let go to install the plugin ${names.join(' and ')}`,
  installed: (n: number) => `Installed ${n === 1 ? 'a plugin' : `${n} plugins`}: it starts at the next start (Settings › Plugins)`,
  plugin: 'Plugin',
  uses: (capabilities: string) => `Uses ${capabilities}`,
  starts: (programs: string) => `Starts the programs ${programs}`,
  more: (n: number) => `+ ${n} more`,
  video: 'Video',
};

export type Messages = typeof en;
