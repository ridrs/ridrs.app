// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The training plan's texts in German (ADR 0072). */
export const de: Messages = {
  dateLocale: 'de-DE',
  today: 'Heute',
  tomorrow: 'Morgen',
  warmUp: 'Aufwärmen',
  coolDown: 'Ausfahren',
  accountReasons: {
    'sign-in-cancelled': 'Anmeldung abgebrochen',
    'sign-in-rejected': 'Anmeldung fehlgeschlagen. Bitte versuche es erneut.',
    'token-rejected': 'intervals.icu akzeptiert diese Verbindung nicht mehr.',
    unreachable: 'intervals.icu war nicht erreichbar.',
  },
  reconnect: 'intervals.icu neu verbinden',
  connect: 'intervals.icu verbinden',
  connecting: 'Verbinde mit intervals.icu…',
  finishSignIn: 'Schließe die Anmeldung in deinem Browser ab.',
  onMainScreen: 'Deine geplanten Workouts auf dem Startbildschirm.',
  connectedAs: (athlete?: string) => (athlete ? `Verbunden als ${athlete}` : 'Verbunden'),
  notConnected: 'Nicht verbunden',
  offline: 'Offline',
  thisDevice: 'ridrs (dieses Gerät)',
  nextWorkoutOn: (name: string, day: string) => `Nächstes Workout: ${name}, ${day}`,
  nonePlanned: 'Kein Workout geplant',
  loading: 'Dein Plan wird geladen',
  loadingDots: 'Dein Plan wird geladen…',
  nextWorkout: 'Nächstes Workout',
  load: (load: number) => `Belastung ${load}`,
  nothingSoon: 'In den nächsten 14 Tagen ist nichts geplant.',
  ftp: 'FTP',
  weight: 'Gewicht',
  refresh: 'Aktualisieren',
  comesFromHere: 'Von hier kommen deine geplanten Workouts.',
  disconnect: 'intervals.icu trennen',
};
