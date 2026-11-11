// SPDX-License-Identifier: AGPL-3.0-or-later

/** The chart's texts in English (ADR 0072): the shape of every language. */
export const en = {
  minutes: (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`,
  /** "65 minutes, 3 intervals of 12 minutes at 90 %". */
  described: (duration: string, estimated: boolean) => (estimated ? `about ${duration}` : duration),
  intervals: (count: number, duration: string, at: string) =>
    `${count} ${count === 1 ? 'interval' : 'intervals'} of ${duration} at ${at}`,
  noSteps: 'No steps',
  neutralHint: 'Set your FTP to see the zones',
  ftp: 'FTP',
  zone: (n: number, name?: string) => (name ? `Zone ${n} · ${name}` : `Zone ${n}`),
  step: (n: number) => `Step ${n}`,
  intensities: {
    'warm-up': 'Warm-up',
    'cool-down': 'Cool-down',
    rest: 'Rest',
    recovery: 'Recovery',
    interval: 'Interval',
    active: 'Active',
    other: 'Step',
  } as Readonly<Record<string, string>>,
  markers: {
    free: 'Free ride',
    'max-effort': 'Max effort',
    'heart-rate': 'Heart rate',
    open: 'Until the lap button',
    other: 'No power target',
  } as Readonly<Record<string, string>>,
  durationEstimated: 'estimated',
  repeat: (n: number) => `${n}×`,
  zoneBar: 'Time in zones',
};

export type Messages = typeof en;
