// SPDX-License-Identifier: AGPL-3.0-or-later

/** The settings' texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'Settings',
  intro: 'Every change takes effect at once.',
  basics: 'Basics',
  units: 'Units',
  metric: 'Metric',
  imperial: 'Imperial',
  language: 'Language',
  sounds: 'Sounds',
  on: 'On',
  off: 'Off',
  advanced: 'Advanced',
  reset: 'Reset to defaults',
  smoothing: 'Power smoothing',
  seconds: (n: number) => `${n} s`,
  frameRate: 'Frame rate',
  showFrameRate: 'Show the frame rate',
  shown: 'Shown',
  hidden: 'Hidden',
  placeholder: 'Units, sounds and smoothing are not read yet; the ride keeps metric units.',
};

export type Messages = typeof en;
