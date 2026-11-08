// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The settings' texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Einstellungen',
  intro: 'Jede Änderung gilt sofort.',
  basics: 'Grundlagen',
  units: 'Einheiten',
  metric: 'Metrisch',
  imperial: 'Imperial',
  language: 'Sprache',
  sounds: 'Töne',
  on: 'An',
  off: 'Aus',
  advanced: 'Erweitert',
  reset: 'Auf Standard zurücksetzen',
  smoothing: 'Leistungsglättung',
  seconds: (n: number) => `${n} s`,
  frameRate: 'Bildrate',
  showFrameRate: 'Bildrate anzeigen',
  shown: 'Sichtbar',
  hidden: 'Verborgen',
  placeholder:
    'Einheiten, Töne und Glättung werden noch nicht ausgewertet; die Fahrt bleibt bei metrischen Einheiten.',
};
