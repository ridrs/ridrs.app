// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The activity menu and debriefing texts in German (ADR 0072, ADR 0108). */
export const de: Messages = {
  menuTitle: 'Aktivitätsmenü',
  continueRide: 'Weiterfahren',
  finishRide: 'Fahrt beenden',
  workout: 'Workout',
  noWorkout: 'Kein Workout',
  loadWorkout: 'Workout laden',
  changeWorkout: 'Workout wechseln',
  planned: 'Geplant',
  library: 'Bibliothek',
  noWorkouts: 'Noch kein Workout im Angebot.',
  route: 'Strecke',
  freeRide: 'Freie Fahrt',
  changeRoute: 'Strecke wechseln',
  notDownloaded: 'Nicht auf diesem Gerät',
  refusal: {
    'no-ftp':
      'Dieses Workout ist in % deiner FTP angegeben, und in deinem Profil steht noch keine FTP. Trage zuerst deine FTP im Profil ein.',
    'no-power-zones':
      'Dieses Workout ist in Leistungszonen angegeben, und in deinem Profil gibt es noch keine. Lege zuerst deine Zonen im Profil fest.',
  },
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
  deleteQuestion: 'Bist du sicher?',
  deleteWarning: 'Diese Fahrt wird unwiderruflich gelöscht.',
  yes: 'Ja',
  no: 'Nein',
  tryAgain: 'Erneut versuchen',
  save: 'Speichern',
  reconnect: 'intervals.icu neu verbinden',
  connect: 'intervals.icu verbinden',
  withoutUpload: 'Ohne Hochladen speichern',
  delete: 'Löschen',
  devices: 'Geräte',
  settings: 'Einstellungen',
  /** The row of Devices and Settings. */
  more: 'Mehr',
};
