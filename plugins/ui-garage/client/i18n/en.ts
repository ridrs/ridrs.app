// SPDX-License-Identifier: AGPL-3.0-or-later

/** The garage's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Garage',
  intro: 'Your bicycle: its weight and its drivetrain change the ride. Every change is kept at once.',
  riding: 'A ride is under way: changes apply from the next ride.',
  bicycle: 'Bicycle',
  name: 'Name',
  weight: 'Weight',
  lowerWeight: 'Lower the weight',
  raiseWeight: 'Raise the weight',
  drivetrain: 'Drivetrain',
  chainrings: (teeth: string) => `Chainrings: ${teeth}`,
  cassette: (teeth: string) => `Cassette: ${teeth}`,
  shiftingMode: 'Shifting mode',
  modes: {
    manual: { label: 'Manual', about: 'The left shifter moves the front derailleur, the right one the rear.' },
    'semi-synchro': {
      label: 'Semi-synchro',
      about: 'You shift the front; the rear shifts two sprockets the other way by itself.',
    },
    'full-synchro': {
      label: 'Full synchro',
      about: 'You shift with the right shifter only; the front switches by itself at the shift points.',
    },
  },
  startGear: 'Start gear',
  startChainring: 'Start chainring',
  teeth: (teeth: number) => `${teeth} teeth`,
  easierStart: 'Easier start gear',
  harderStart: 'Harder start gear',
};

export type Messages = typeof en;
