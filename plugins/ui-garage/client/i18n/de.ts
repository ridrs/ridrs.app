// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The garage's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Garage',
  intro: 'Dein Fahrrad: Gewicht und Antrieb verändern die Fahrt. Jede Änderung gilt sofort.',
  riding: 'Eine Fahrt läuft: Änderungen gelten ab der nächsten Fahrt.',
  bicycle: 'Fahrrad',
  name: 'Name',
  weight: 'Gewicht',
  lowerWeight: 'Gewicht verringern',
  raiseWeight: 'Gewicht erhöhen',
  drivetrain: 'Antrieb',
  chainrings: (teeth: string) => `Kettenblätter: ${teeth}`,
  cassette: (teeth: string) => `Kassette: ${teeth}`,
  shiftingMode: 'Schaltmodus',
  modes: {
    manual: { label: 'Manuell', about: 'Der linke Schalthebel bewegt den Umwerfer, der rechte das Schaltwerk.' },
    'semi-synchro': {
      label: 'Semi-Synchro',
      about: 'Du schaltest vorne; hinten schaltet es von selbst zwei Ritzel in die Gegenrichtung.',
    },
    'full-synchro': {
      label: 'Full-Synchro',
      about: 'Du schaltest nur mit dem rechten Hebel; vorne wechselt es an den Schaltpunkten von selbst.',
    },
  },
  startGear: 'Startgang',
  startChainring: 'Kettenblatt beim Start',
  teeth: (teeth: number) => `${teeth} Zähne`,
  easierStart: 'Leichterer Startgang',
  harderStart: 'Schwererer Startgang',
};
