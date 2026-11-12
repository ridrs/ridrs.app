// SPDX-License-Identifier: AGPL-3.0-or-later

import { localizeNumber } from '@ridrs/ui-sdk';
import type { Messages } from './en.ts';

/** The ride area's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Fahren',
  intro: 'Frei fahren: Welten, Routen und echte Videos. Route wählen, dann Los.',
  filters: 'Filter',
  filter: { flat: 'Flach', hilly: 'Hügelig', short: 'Unter 45 min', favourites: 'Favoriten' },
  worlds: 'Welten und Routen',
  noWorld: 'Keine Welt bietet eine Route an.',
  videos: 'Echte Videos',
  noVideo: 'Keine Videoquelle bietet eine Route an.',
  noMatch: 'Keine Route passt zu den Filtern.',
  later: 'Karte, Pacer und Gruppen',
  laterAbout: 'Eine Karte jeder Welt, Pacer-Bots und Gruppenfahrten folgen später.',
  onToday: 'Auf Heute',
  showOnToday: 'Nochmal fahren auf Heute zeigen',
  rideAgain: 'Nochmal fahren',
  rideAgainButton: (title: string) => `${title} nochmal fahren`,
  video: 'Video',
  route: 'Route',
  part: (tour: string, part: number) => `${tour}, Teil ${part}`,
  countries: { France: 'Frankreich', Germany: 'Deutschland' },
  levels: { Easy: 'Leicht', Moderate: 'Mittel', Hard: 'Schwer' },
  favourite: 'Favorit',
  favouriteOf: (title: string) => `${title} als Favorit`,
  profileOf: (title: string) => `Höhenprofil von ${title}`,
  details: (title: string) => `Details zu ${title}`,
  distance: 'Distanz',
  climb: 'Anstieg',
  duration: 'Dauer',
  level: 'Schwierigkeit',
  go: 'Los',
  download: 'Herunterladen',
  downloadOf: (title: string) => `${title} herunterladen`,
  cancelDownload: 'Download abbrechen',
  cancelDownloadOf: (title: string) => `Download von ${title} abbrechen`,
  remove: 'Von diesem Gerät entfernen',
  notHere: (size: string) => `Noch nicht auf diesem Gerät: ${size} zum Herunterladen`,
  downloading: (percent: number) => `Wird heruntergeladen: ${percent} %`,
  failed: 'Download fehlgeschlagen',
  failedBecause: (reason: string) => `Download fehlgeschlagen: ${reason}`,
  importingRoute: 'Wird importiert: fahrbar, sobald sie auf diesem Gerät ist',
  onDevice: 'Auf diesem Gerät',
  importVideo: 'Video importieren',
  importKind: 'Import',
  importAbout: 'Ein Incyclist-Paket (.zip oder .ride) mit Video, GPX-Track und Steuerdatei',
  importing: 'Wird importiert',
  importingFile: (file: string) => `${file} wird importiert`,
  importFailed: 'Import fehlgeschlagen',
  importFailedBecause: (reason: string) => `Import fehlgeschlagen: ${reason}`,
  profile: 'Profil',
  climbs: 'Anstiege',
  gradients: 'Steigungen',
  credits: (author: string, source: string, license: string, url: string) =>
    `Von ${author}, ${source}, ${license}. ${url}`,
  km: (metres: number) => localizeNumber((metres / 1000).toFixed(1), 'de'),
  kmAt: (km: string) => `km ${km}`,
  metres: (metres: number) => `${Math.round(metres)} m`,
  category: (category: string) => (category === 'HC' ? 'HC' : `Kat. ${category}`),
  describeClimb: (category: string, summit: number, at: string, length: string, grade: number) =>
    `${category}: Gipfel ${Math.round(summit)} m bei km ${at} · ${length} km mit ${localizeNumber(grade.toFixed(1), 'de')} %`,
  about: (minutes: number) =>
    minutes < 60 ? `etwa ${minutes} min` : `etwa ${Math.floor(minutes / 60)} h ${minutes % 60} min`,
  size: (bytes: number) =>
    bytes >= 1e9
      ? `${localizeNumber((bytes / 1e9).toFixed(1), 'de')} GB`
      : `${Math.max(1, Math.round(bytes / 1e6))} MB`,
  grades: ['unter 2 %', '2–4 %', '4–6 %', '6–8 %', '8–10 %', '10 % und mehr'],
};
