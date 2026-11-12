// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

const workouts = (n: number) => `${n} ${n === 1 ? 'Workout' : 'Workouts'}`;
const routes = (n: number) => `${n} ${n === 1 ? 'Videoroute' : 'Videorouten'}`;

export const de: Messages = {
  layerLabel: 'Auf ridrs gezogene Dateien',
  reading: (name) => `${name} wird gelesen …`,
  letGoWorkouts: (n) => `${workouts(n)} zu deinen Workouts`,
  letGoRoutes: (n) => `${routes(n)} zu deinen Routen`,
  letGo: (parts) => `Loslassen fügt ${parts.join(' und ')} hinzu`,
  alreadyThere: 'Schon in deinen Workouts',
  adding: 'Wird hinzugefügt …',
  added: (n) => `${workouts(n)} zu deinen Workouts hinzugefügt`,
  importingRoutes: (n) => `${routes(n)} ${n === 1 ? 'wird' : 'werden'} importiert: siehe Fahren › Echte Videos`,
  failed: (n) => `${n} konnte${n === 1 ? '' : 'n'} nicht hinzugefügt werden`,
  more: (n) => `+ ${n} weitere`,
  workout: 'Workout',
  videoRoute: 'Videoroute',
};
