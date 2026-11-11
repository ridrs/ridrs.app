// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The training area's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Training',
  intro:
    'Der Kalender ist die Zentrale: Ein Workout von unten auf einen Tag ziehen plant es, ein geplantes Workout auf einen anderen Tag ziehen verschiebt es.',
  pictureCredits: 'Foto: Munbaik Cycling Clothing, Unsplash',
  weekdays: {
    Monday: 'Montag',
    Tuesday: 'Dienstag',
    Wednesday: 'Mittwoch',
    Thursday: 'Donnerstag',
    Friday: 'Freitag',
    Saturday: 'Samstag',
    Sunday: 'Sonntag',
  },
  short: (day: string) => day.slice(0, 2),
  today: 'heute',
  kinds: { rest: 'Ruhetag', note: 'Notiz', outdoor: 'Ausfahrt draußen' },
  previousWeek: 'Vorherige Woche',
  nextWeek: 'Nächste Woche',
  openLarge: 'Große Kalenderansicht öffnen',
  thisWeekOnly: 'Der Kalender von ridrs gilt nur für diese Woche: In den Einstellungen lässt sich ein anderer Kalender wählen.',
  back: 'Zurück',
  calendar: 'Kalender',
  thisWeek: 'Diese Woche',
  previousMonth: 'Vorheriger Monat',
  nextMonth: 'Nächster Monat',
  thisMonth: 'Dieser Monat',
  asPlanned: 'wie geplant',
  ridAsPlanned: (plan: string) => `Wie geplant gefahren: ${plan}`,
  dateLocale: 'de-DE',
  exportLater: 'Export in Google-, Apple- und Outlook-Kalender folgt später.',
  workouts: 'Workouts',
  zones: { 'sweet-spot': 'Sweet Spot', 'vo2-max': 'VO2max', endurance: 'Grundlage', recovery: 'Erholung' },
  favourite: (name: string) => `${name} als Favorit`,
  library: 'Workout-Bibliothek',
  planRefused: (source: string, reason: 'read-only' | 'unreachable') =>
    reason === 'read-only'
      ? `${source} kann nicht aus der Bibliothek geändert werden.`
      : `${source} war nicht erreichbar: Es wurde nichts eingeplant.`,
  saving: 'Wird gespeichert…',
  writeFailed: (source: string) => `${source} hat die Änderung nicht angenommen.`,
  libraryEmpty: 'Deine Quellen haben noch keine Workouts.',
  thisDevice: 'ridrs (dieses Gerät)',
  plans: 'Trainingspläne',
  baseBuilder: '8 Wochen · 6 h pro Woche · baut Grundlagenausdauer auf',
  ftpBuilder: '6 Wochen · 5 h pro Woche · hebt die Schwelle',
  suggestion: 'Vorschlag',
  suggestionLater:
    'Ein Vorschlag für heute aus deiner Woche und deiner Form folgt später. Bis dahin passt Endurance 90 zu einem Tag ohne anderes Training.',
};
