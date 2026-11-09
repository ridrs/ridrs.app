// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The Me area's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Ich',
  intro: 'Deine Fahrten, dein Fortschritt und dein Konto.',
  profile: 'Profil',
  lower: (name: string) => `${name} verringern`,
  raise: (name: string) => `${name} erhöhen`,
  progress: 'Fortschritt und FTP',
  ftp: 'FTP',
  save: 'Speichern',
  discard: 'Verwerfen',
  unsaved: 'Noch nicht gespeichert.',
  weight: 'Gewicht',
  weeklyGoal: 'Wochenziel',
  thisDevice: 'ridrs (dieses Gerät)',
  wattsPerKg: (ratio: string) => `${ratio} W/kg.`,
  fromSource: (source: string) => `Von ${source}.`,
  readOnly: (source: string) => `${source} kann hier nicht geändert werden.`,
  refused: (source: string, reason: 'read-only' | 'unreachable') =>
    reason === 'read-only'
      ? `${source} kann hier nicht geändert werden.`
      : `${source} war nicht erreichbar: Der Wert bleibt, wie er war.`,
  rideUses: 'Die nächste Fahrt nutzt dein Gewicht; die FTP wird noch nicht genutzt.',
  activities: 'Aktivitäten',
  activitiesSoon: 'Hier stehen bald deine aufgezeichneten Fahrten mit ihren FIT-Dateien.',
  achievements: 'Erfolge',
  first100: 'Die ersten 100 km',
  first100About: 'Fahre insgesamt 100 km',
  climber: 'Kletterer',
  climberAbout: 'Fahre 1.000 Höhenmeter in einer Fahrt',
  account: 'Konto und Abo',
  accountSoon: 'Anmeldung, Profil und Abo kommen mit dem Athletenprofil.',
  connected: 'Verbundene Dienste',
  onToday: 'Auf Heute',
  showOnToday: 'Wochenziel auf Heute zeigen',
  hoursOf: (ridden: string, goal: string) => `${ridden} von ${goal} h`,
  shareOfGoal: (percent: number) => `${percent} % des Wochenziels`,
  changeGoal: 'Ziel ändern',
};
