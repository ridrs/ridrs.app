// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The companion app's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'ridrs Companion',
  developerBuild: 'Entwickler-Build',
  companionName: 'Name der Companion-App',
  rename: 'Umbenennen',
  notAPairingCode: 'Das ist kein ridrs-Kopplungscode. Scanne den QR-Code, den ridrs zeigt.',
  scanFailed: (error: string) => `Scannen fehlgeschlagen: ${error}`,
  scanned: (ridrs: string) => `Gescannt. Warte, bis sich „${ridrs}“ verbindet…`,
  connected: 'verbunden',
  disconnectedHere: 'hier getrennt',
  disconnectedInRidrs: 'in ridrs getrennt',
  waiting: 'nicht verbunden, wartet darauf',
  disconnect: 'Trennen',
  connect: 'Verbinden',
  forget: 'Vergessen',
  pairedAndConnected: 'Gekoppelt und verbunden',
  scan: 'ridrs-QR-Code scannen',
  orEnter: 'Oder gib diesen Code in ridrs ein:',
  findsIn: (name: string, addresses: string) =>
    `ridrs findet „${name}“ im selben WLAN (${addresses}).`,
  noWifi: 'Keine WLAN-Adresse: Verbinde das Handy mit einem WLAN.',
  forwardingTo: (ridrs: string) => `Leitet weiter an ${ridrs}`,
  notForwarding: 'Leitet nichts weiter',
  counts: (devices: number, subscriptions: number, rate: number) =>
    `${devices} Gerät(e) verbunden · ${subscriptions} Abo(s) · ${rate} Benachrichtigungen/s`,
  keepOpen:
    'Lass diese App offen: Das Handy leitet Bluetooth nur weiter, solange der Bildschirm an ist.',
  couldNotStart: (error: string) => `Die Companion-App konnte nicht starten: ${error}`,
};
