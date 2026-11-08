// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pairing's texts in English (ADR 0072): the shape of every language. */
export const en = {
  codeFor: (companion: string) => `Pairing code for ${companion}`,
  qrAlt: 'Pairing QR code: scan it with the ridrs companion app',
  scan: 'Scan the QR code',
  or: 'or',
  enter: 'Enter the code',
  looking: 'Looking for phones on this Wi-Fi…',
};

export type Messages = typeof en;
