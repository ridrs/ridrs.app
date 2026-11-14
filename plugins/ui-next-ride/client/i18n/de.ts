// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

export const de: Messages = {
  nextRide: 'Nächste Fahrt',
  workout: 'Workout',
  route: 'Strecke',
  dropWorkout: 'Workout hier ablegen',
  dropRoute: 'Strecke hier ablegen',
  start: 'Nächste Fahrt starten',
  gone: 'Nicht mehr vorhanden',
  removeWorkout: 'Workout aus der nächsten Fahrt nehmen',
  removeRoute: 'Strecke aus der nächsten Fahrt nehmen',
  minutes: (minutes: number) => `${minutes} min`,
  kilometres: (km: string) => `${km} km`,
  numberLocale: 'de-DE',
};
