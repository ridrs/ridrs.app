// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Span } from '../model.ts';

/** The workout widget's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Workout',
  freeRide: 'Free ride',
  maxEffort: 'Max effort',
  heartRate: (bpm: string) => `${bpm} bpm`,
  /** "4 min", "1 min 30 s", "1 h 5 min": the length of a timed segment. */
  span: ({ hours, minutes, seconds }: Span) =>
    [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', seconds || !(hours || minutes) ? `${seconds} s` : '']
      .filter(Boolean)
      .join(' '),
  rpm: 'rpm',
  untilNext: 'until the next step',
  distance: (meters: number) => (meters >= 1000 ? `${Math.round(meters / 100) / 10} km` : `${Math.round(meters)} m`),
  energy: (kilocalories: number) => `${Math.round(kilocalories)} kcal`,
  left: (time: string) => `${time} left`,
  countdown: (seconds: number) => `Next step in ${seconds}`,
  done: 'Workout done',
  barLabel: 'Time left in the step',
  /** "Segments": the list, read out. */
  segmentsLabel: 'Segments',
  /** "5/10" read out. */
  positionLabel: (at: number, of: number) => `Segment ${at} of ${of}`,
  /** Short HUD header label before "5/10". */
  step: 'Step',
  totalLeft: 'Time left in the workout',
  /** The footer: the workout's intensity, changed with plus and minus. */
  intensity: 'Intensity',
};

export type Messages = typeof en;
