// SPDX-License-Identifier: AGPL-3.0-or-later


import type { DataSourceStatus } from '@ridrs/contracts';

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
  about: 'About',
  appName: 'ridrs',
  version: (version: string) => `Version ${version}`,
  licensedUnder: 'Licensed under GNU AGPL v3 or later',
  sourceCode: 'Source code',
  licensesAndCredits: 'Licenses & credits',
  licensesIntro:
    'ridrs is free software. These are the third-party components and content it contains, each with its license.',
  loading: 'Loading…',
  back: 'Back',
  appEntry: 'ridrs itself',
  contentSection: 'Third-party content',
  componentsSection: 'Components',
  contentBy: (author: string) => `By ${author}`,
  licenseName: (license: string) => `License: ${license}`,
  dataSources: 'Data sources',
  athleteProfile: 'Athlete profile',
  plannedWorkouts: 'Planned workouts',
  workoutLibrary: 'Workout library',
  allReadOnly: 'all providers, read only',
  thisDevice: 'ridrs (this device)',
  status: (status: DataSourceStatus, loadedAt?: string) =>
    ({
      ready: 'Ready',
      offline: loadedAt === undefined ? 'Offline' : `Offline · last loaded ${loadedAt}`,
      unavailable: 'Not available',
      loading: 'Loading…',
    })[status],
  riding: 'A ride is under way: a new source applies from the next ride.',
  placeholder: 'Units, sounds and smoothing are not read yet; the ride keeps metric units.',
};

export type Messages = typeof en;
