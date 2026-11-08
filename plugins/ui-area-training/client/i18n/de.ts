// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The training area's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Training',
  intro:
    'Der Kalender ist die Zentrale: Einträge hinzufügen, verschieben und entfernen, Workouts aus der Bibliothek einplanen. Jede Änderung gilt sofort; Rückgängig nimmt sie zurück.',
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
  move: (entry: string, from: string, to: string) => `${entry} von ${from} auf ${to} verschieben`,
  later: 'Später',
  removeFrom: (entry: string, day: string) => `${entry} am ${day} entfernen`,
  remove: 'Entfernen',
  thisWeek: 'Diese Woche',
  addRest: (day: string) => `Ruhetag am ${day} hinzufügen`,
  addNote: (day: string) => `Notiz am ${day} hinzufügen`,
  addOutdoor: (day: string) => `Ausfahrt draußen am ${day} hinzufügen`,
  undo: 'Rückgängig',
  exportLater: 'Export in Google-, Apple- und Outlook-Kalender folgt später.',
  workouts: 'Workouts',
  zones: { 'sweet-spot': 'Sweet Spot', 'vo2-max': 'VO2max', endurance: 'Grundlage', recovery: 'Erholung' },
  favourite: (name: string) => `${name} als Favorit`,
  schedule: (name: string, day: string) => `${name} am ${day} einplanen`,
  library: 'Workout-Bibliothek',
  libraryEmpty: 'Deine Quellen haben noch keine Workouts.',
  thisDevice: 'ridrs (dieses Gerät)',
  plans: 'Trainingspläne',
  baseBuilder: '8 Wochen · 6 h pro Woche · baut Grundlagenausdauer auf',
  ftpBuilder: '6 Wochen · 5 h pro Woche · hebt die Schwelle',
  suggestion: 'Vorschlag',
  suggestionLater:
    'Ein Vorschlag für heute aus deiner Woche und deiner Form folgt später. Bis dahin passt Endurance 90 zu einem Tag ohne anderes Training.',
};
