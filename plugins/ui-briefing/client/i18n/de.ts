// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The briefing's texts in German (ADR 0072). */
export const de: Messages = {
  locale: 'de-DE',
  title: 'Vor der Fahrt',
  back: 'Zurück',
  loading: 'Wird vorbereitet…',
  route: 'Route',
  freeRide: 'Freie Fahrt',
  noRoutes: 'Noch keine Route im Angebot.',
  routeMissing: 'Diese Route wird nicht mehr angeboten. Wähle eine andere.',
  workout: 'Workout',
  noWorkout: 'Kein Workout',
  planned: 'Geplant',
  library: 'Bibliothek',
  noWorkouts: 'Noch kein Workout im Angebot.',
  workoutMissing: 'Dieses Workout gibt es in deiner Bibliothek und deinem Kalender nicht mehr. Wähle ein anderes.',
  bicycle: 'Fahrrad',
  riding: (name: string, kg: string) => `${name} · ${kg} kg`,
  changeRoute: 'Route ändern',
  changeWorkout: 'Workout ändern',
  changeBicycle: 'Fahrrad ändern',
  chosen: 'Gewählt',
  preview: 'Vorschau',
  routeProfile: 'Routenprofil',
  workoutChart: 'Workout-Grafik',
  chartFallback: (duration: string, load: string | undefined) =>
    load === undefined ? duration : `${duration} · TSS ${load}`,
  summary: 'Zusammenfassung',
  duration: 'Dauer',
  distance: 'Distanz',
  trainingLoad: 'TSS',
  timeInZones: 'Zeit pro Zone',
  zonesNeedFtp: 'Mit einer FTP in deinem Profil steht hier die Zeit pro Zone.',
  ready: 'Bereit?',
  trainer: 'Trainer',
  heartRate: 'Herzfrequenz',
  connected: (name: string) => (name ? `${name} verbunden` : 'Verbunden'),
  notConnected: 'Nicht verbunden',
  pair: 'Koppeln',
  pairTrainer: 'Trainer koppeln',
  pairHeartRate: 'Herzfrequenz koppeln',
  routeReady: 'Die Route ist auf diesem Gerät',
  routeNotReady: 'Die Route ist noch nicht auf diesem Gerät',
  download: 'Herunterladen',
  downloadRoute: 'Route herunterladen',
  workoutLonger: (workout: string, route: string) =>
    `Workout ${workout}, Route etwa ${route}: Das Bild bleibt dann stehen, und das Workout läuft weiter.`,
  routeLonger: (workout: string, route: string) =>
    `Workout ${workout}, Route etwa ${route}: Das Workout endet zuerst, dann fährst du im Widerstandsmodus auf der Route weiter.`,
  minutes: (seconds: number) => `${Math.round(seconds / 60)} min`,
  start: 'Starten',
  refusal: {
    'no-ftp':
      'Dieses Workout ist in % deiner FTP angegeben, und in deinem Profil steht noch keine FTP. Trage deine FTP im Profil ein und starte dann erneut.',
    'no-power-zones':
      'Dieses Workout ist in Leistungszonen angegeben, und in deinem Profil gibt es noch keine. Lege deine Zonen im Profil fest und starte dann erneut.',
  },
};
