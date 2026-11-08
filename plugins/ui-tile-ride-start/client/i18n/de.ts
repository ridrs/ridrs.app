// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The ride start tile's texts in German (ADR 0072). */
export const de: Messages = {
  ride: 'Fahrt',
  freeRide: 'Freie Fahrt',
  ready: 'Bereit zum Fahren?',
  about: 'Fahre in deinem Tempo. Deine Geräte kommen dazu, sobald sie verbunden sind.',
  riding: (bicycle: string, kg: string) => `Mit ${bicycle} · ${kg} kg`,
  profileUnavailable: 'Dein Athletenprofil ist nicht verfügbar: Die nächste Fahrt nutzt Standardwerte.',
  start: 'Fahrt starten',
  notSaved: 'Die Fahrt konnte nicht gespeichert werden',
  saved: 'Fahrt gespeichert',
  kmIn: 'km in',
};
