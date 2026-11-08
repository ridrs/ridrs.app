// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The debriefing's texts in German (ADR 0072). */
export const de: Messages = {
  finished: 'Fahrt beendet',
  distance: 'Distanz',
  time: 'Zeit',
  km: (km: string) => `${km} km`,
  notRecorded: 'Die Fahrt konnte nicht aufgezeichnet werden.',
  uploading: 'Wird zu intervals.icu hochgeladen…',
  kept: 'Die Fahrt bleibt auf diesem Gerät.',
  failures: {
    'not-connected': 'intervals.icu ist nicht verbunden.',
    'token-rejected': 'intervals.icu bittet dich, die Verbindung zu erneuern.',
    unreachable: 'intervals.icu war nicht erreichbar.',
    rejected: 'intervals.icu hat die Fahrt nicht angenommen.',
  },
  uploadFailed: 'Das Hochladen ist fehlgeschlagen.',
  saveUploads: (athlete?: string) =>
    `Speichern lädt die Fahrt zu intervals.icu hoch${athlete ? ` als ${athlete}` : ''}.`,
  saveKeeps:
    'Speichern behält die Fahrt auf diesem Gerät. Verbinde intervals.icu unter „Ich“, um Fahrten hochzuladen.',
  deleteQuestion: 'Diese Fahrt löschen?',
  deleteWarning: 'Diese Fahrt löschen? Sie lässt sich nicht wiederherstellen.',
  deleteRide: 'Fahrt löschen',
  keepRide: 'Fahrt behalten',
  tryAgain: 'Erneut versuchen',
  save: 'Speichern',
  reconnect: 'intervals.icu neu verbinden',
  connect: 'intervals.icu verbinden',
  withoutUpload: 'Ohne Hochladen speichern',
  delete: 'Löschen',
};
