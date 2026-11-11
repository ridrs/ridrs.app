// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

export const de: Messages = {
  minutes: (n) => `${n} ${n === 1 ? 'Minute' : 'Minuten'}`,
  described: (duration, estimated) => (estimated ? `etwa ${duration}` : duration),
  intervals: (count, duration, at) =>
    `${count} ${count === 1 ? 'Intervall' : 'Intervalle'} à ${duration} bei ${at}`,
  noSteps: 'Keine Schritte',
  neutralHint: 'FTP eintragen, um die Zonen zu sehen',
  ftp: 'FTP',
  zone: (n, name) => (name ? `Zone ${n} · ${name}` : `Zone ${n}`),
  step: (n) => `Schritt ${n}`,
  intensities: {
    'warm-up': 'Einfahren',
    'cool-down': 'Ausfahren',
    rest: 'Pause',
    recovery: 'Erholung',
    interval: 'Intervall',
    active: 'Aktiv',
    other: 'Schritt',
  },
  markers: {
    free: 'Freie Fahrt',
    'max-effort': 'Maximaler Einsatz',
    'heart-rate': 'Herzfrequenz',
    open: 'Bis zur Runden-Taste',
    other: 'Kein Leistungsziel',
  },
  durationEstimated: 'geschätzt',
  repeat: (n) => `${n}×`,
  zoneBar: 'Zeit in den Zonen',
};
