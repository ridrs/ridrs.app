// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DataSourceStatus } from '@ridrs/contracts';
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
  about: 'Über ridrs',
  appName: 'ridrs',
  version: (version: string) => `Version ${version}`,
  licensedUnder: 'Lizenziert unter der GNU AGPL v3 oder neuer',
  sourceCode: 'Quellcode',
  licensesAndCredits: 'Lizenzen & Danksagungen',
  licensesIntro:
    'ridrs ist freie Software. Hier stehen die Komponenten und Inhalte Dritter, die es enthält, jeweils mit ihrer Lizenz.',
  loading: 'Lädt…',
  back: 'Zurück',
  appEntry: 'ridrs selbst',
  contentSection: 'Drittinhalte',
  componentsSection: 'Komponenten',
  contentBy: (author: string) => `Von ${author}`,
  licenseName: (license: string) => `Lizenz: ${license}`,
  dataSources: 'Datenquellen',
  athleteProfile: 'Athletenprofil',
  plannedWorkouts: 'Geplante Trainings',
  thisDevice: 'ridrs (dieses Gerät)',
  status: (status: DataSourceStatus, loadedAt?: string) =>
    ({
      ready: 'Bereit',
      offline: loadedAt === undefined ? 'Offline' : `Offline · zuletzt geladen ${loadedAt}`,
      unavailable: 'Nicht verfügbar',
      loading: 'Lädt …',
    })[status],
  riding: 'Eine Fahrt läuft: Eine neue Quelle gilt ab der nächsten Fahrt.',
  placeholder:
    'Einheiten, Töne und Glättung werden noch nicht ausgewertet; die Fahrt bleibt bei metrischen Einheiten.',
};
