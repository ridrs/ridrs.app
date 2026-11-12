// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Messages } from './en.ts';

/** The workout widget's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Workout',
  now: 'JETZT',
  next: 'DANACH',
  at: 'bei',
  freeRide: 'Freie Fahrt',
  maxEffort: 'Maximaler Einsatz',
  heartRate: (bpm: string) => `${bpm} bpm`,
  rpm: 'U/min',
  untilNext: 'bis zum nächsten Schritt',
  distance: (meters: number) =>
    meters >= 1000 ? `${String(Math.round(meters / 100) / 10).replace('.', ',')} km` : `${Math.round(meters)} m`,
  energy: (kilocalories: number) => `${Math.round(kilocalories)} kcal`,
  left: (time: string) => `noch ${time}`,
  setLabel: (at: number, of: number) => `${at} von ${of}`,
  countdown: (seconds: number) => `Nächster Schritt in ${seconds}`,
  done: 'Workout geschafft',
  starting: 'Mach dich bereit',
  barLabel: 'Restzeit im Schritt',
};
