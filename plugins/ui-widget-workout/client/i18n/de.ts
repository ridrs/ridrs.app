// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Span } from '../model.ts';
import type { Messages } from './en.ts';

/** The workout widget's texts in German (ADR 0072). */
export const de: Messages = {
  title: 'Workout',
  freeRide: 'Freie Fahrt',
  maxEffort: 'Maximaler Einsatz',
  heartRate: (bpm: string) => `${bpm} bpm`,
  span: ({ hours, minutes, seconds }: Span) =>
    [hours ? `${hours} Std.` : '', minutes ? `${minutes} Min.` : '', seconds || !(hours || minutes) ? `${seconds} s` : '']
      .filter(Boolean)
      .join(' '),
  rpm: 'U/min',
  untilNext: 'bis zum nächsten Schritt',
  distance: (meters: number) =>
    meters >= 1000 ? `${String(Math.round(meters / 100) / 10).replace('.', ',')} km` : `${Math.round(meters)} m`,
  energy: (kilocalories: number) => `${Math.round(kilocalories)} kcal`,
  left: (time: string) => `noch ${time}`,
  countdown: (seconds: number) => `Nächster Schritt in ${seconds}`,
  done: 'Workout geschafft',
  barLabel: 'Restzeit im Schritt',
  /** "Segments": the list, read out. */
  segmentsLabel: 'Segmente',
  /** "5/10" read out. */
  positionLabel: (at: number, of: number) => `Segment ${at} von ${of}`,
  totalLeft: 'Restzeit im Workout',
};
