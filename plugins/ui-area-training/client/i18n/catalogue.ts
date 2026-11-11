// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Catalogs } from '@ridrs/ui-sdk';
import type { DurationClass } from '../catalogue.ts';

/** The texts of browsing and filtering the workout catalogue (ADR 0072), apart from the area's own. */
const en = {
  filters: 'Filter the workouts',
  all: 'All',
  focus: 'Focus',
  duration: 'Duration',
  provider: 'Source',
  noMatch: 'No workout matches these filters.',
  importWorkouts: 'Import workouts',
  newWorkout: 'New workout',
  focuses: {
    recovery: 'Recovery',
    endurance: 'Endurance',
    tempo: 'Tempo',
    'sweet-spot': 'Sweet spot',
    threshold: 'Threshold',
    vo2max: 'VO2 max',
    anaerobic: 'Anaerobic',
    sprint: 'Sprint',
    test: 'Test',
  } as Readonly<Record<string, string>>,
  durations: {
    short: 'Up to 30 min',
    medium: '30 to 60 min',
    long: '60 to 90 min',
    'extra-long': 'Over 90 min',
  } as Readonly<Record<DurationClass, string>>,
  /** The chart's place while the chart plugin is not there: "65 min · TSS 72". */
  summary: (minutes: number | undefined, load: number | undefined) =>
    [minutes === undefined ? undefined : `${minutes} min`, load === undefined ? undefined : `TSS ${load}`]
      .filter(Boolean)
      .join(' · '),
};

export type CatalogueMessages = typeof en;

const de: CatalogueMessages = {
  filters: 'Workouts filtern',
  all: 'Alle',
  focus: 'Schwerpunkt',
  duration: 'Dauer',
  provider: 'Quelle',
  noMatch: 'Kein Workout passt zu diesen Filtern.',
  importWorkouts: 'Workouts importieren',
  newWorkout: 'Neues Workout',
  focuses: {
    recovery: 'Erholung',
    endurance: 'Grundlage',
    tempo: 'Tempo',
    'sweet-spot': 'Sweet Spot',
    threshold: 'Schwelle',
    vo2max: 'VO2max',
    anaerobic: 'Anaerob',
    sprint: 'Sprint',
    test: 'Test',
  },
  durations: {
    short: 'Bis 30 Min.',
    medium: '30 bis 60 Min.',
    long: '60 bis 90 Min.',
    'extra-long': 'Über 90 Min.',
  },
  summary: en.summary,
};

export const catalogueMessages: Catalogs<CatalogueMessages> = { en, de };
