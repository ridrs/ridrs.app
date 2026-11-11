// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutIntensity } from '@ridrs/contracts';

/** The texts of the workout details in English (ADR 0072): the shape of every language. */
export const en = {
  locale: 'en-GB',
  back: 'Back',
  edit: 'Edit',
  export: 'Export',
  exportMissing: 'The export of workouts is not installed.',
  editorMissing: 'The editor is not available.',
  editAsCopy: 'Edit as a copy',
  details: (name: string) => `Details of ${name}`,
  by: (author: string) => `by ${author}`,
  plannedFor: (day: string) => `Planned for ${day}`,
  loading: 'Loading the workout…',
  missing: 'This workout is no longer there.',
  numbers: 'Numbers',
  duration: 'Duration',
  trainingLoad: 'TSS',
  intensityFactor: 'IF',
  work: 'Work',
  estimated: 'Estimated: not every step goes by time and power.',
  timeInZones: 'Time per zone',
  zonesNeedFtp: 'With an FTP in your profile, the time per zone shows here.',
  withoutPowerTarget: 'Without a power target',
  steps: 'Steps',
  chart: 'Chart',
  chartFallback: (duration: string, load?: string) =>
    load === undefined ? duration : `${duration} · ${load} TSS`,
  intensities: {
    'warm-up': 'Warm-up',
    active: 'Active',
    interval: 'Interval',
    rest: 'Rest',
    recovery: 'Recovery',
    'cool-down': 'Cool-down',
    other: 'Step',
  } satisfies Record<WorkoutIntensity, string>,
  step: 'Step',
  freeRide: 'Free ride',
  maxEffort: 'Max effort',
  untilLapButton: 'until the lap button',
  above: 'above',
  below: 'below',
  until: (quantity: string, comparison: string, value: string) =>
    `until ${quantity} ${comparison} ${value}`,
  repeatFor: (what: string) => `Repeat for ${what}`,
  repeatUntil: (condition: string) => `Repeat ${condition}`,
  quantities: {
    power: 'power',
    heartRate: 'heart rate',
    cadence: 'cadence',
    speed: 'speed',
    effort: 'perceived effort',
  },
  units: {
    percentLthr: '% LTHR',
    percentMaxHr: '% HRmax',
    heartRateZone: 'HR',
    percentThresholdSpeed: '% threshold speed',
    rpe: 'RPE',
  },
  marks: {
    'heart-rate': 'Heart rate',
    distance: 'Distance',
    energy: 'Energy',
    until: 'Until',
    open: 'Lap button',
  },
};

export type Messages = typeof en;
