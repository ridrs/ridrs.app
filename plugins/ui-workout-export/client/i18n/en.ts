// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkoutSourceFormat } from '@ridrs/contracts';

/** The texts of the workout export in English (ADR 0072): the shape of every language. */
export const en = {
  locale: 'en-GB',
  back: 'Back',
  title: (name: string) => `Export ${name}`,
  loading: 'Loading the workout…',
  missing: 'This workout is no longer there.',
  formatLabel: 'Format',
  formats: {
    zwo: 'ZWO (Zwift)',
    fit: 'FIT (Garmin)',
    erg: 'ERG',
    mrc: 'MRC',
    tcx: 'TCX (Garmin)',
    intervals: 'intervals.icu text',
  } satisfies Record<WorkoutSourceFormat, string>,
  warningsHeading: 'What changes in this format',
  noWarnings: 'Nothing is converted or lost in this format.',
  at: (place: string) => `(${place})`,
  refusedHeading: (format: string) => `Cannot export to ${format}`,
  refusedFtp:
    'This format cannot hold the unit the workout is in, and converting it needs your FTP. Set your FTP in your profile, or choose a format that can hold it.',
  refusedOther: 'The workout cannot be written in this format.',
  fileName: 'File name',
  save: 'Save…',
  saving: 'Saving…',
  saved: (fileName: string) => `Saved ${fileName}.`,
  notSaved: 'Not saved.',
  failed: 'The file could not be saved.',
  warnings: {
    'watts-to-percent': 'Watts are converted to % FTP with your FTP.',
    'percent-to-watts': '% FTP is converted to watts with your FTP.',
    'zone-converted': 'Zones are written as the power range of the zone.',
    'zone-range': 'This format holds one zone; the lowest of a range is written.',
    'range-to-middle': 'A range is written as its middle; this format holds one value.',
    'repeat-unrolled': 'A repeat is written out step by step.',
    'repeats-unrolled': 'Repeats are written out round by round.',
    'repeat-until-once': 'A repeat that does not end by a count is written once.',
    'target-to-free-ride': 'A target this format cannot hold becomes a free ride.',
    'target-held': 'A step without a power target holds the last power.',
    'target-dropped': 'A target this format cannot hold is not written.',
    'duration-estimated':
      'A step that does not end by time becomes a time step with an estimated length.',
    'cadence-dropped': 'Cadence targets are not written.',
    'secondary-dropped': 'A second target of a step is not written.',
    'step-names-dropped': 'Names and notes of steps are not written.',
    'metadata-dropped': 'Some details of the workout have no place in this format.',
    'ramp-stepped': 'A ramp is written as a run of small steps.',
    'ramp-as-range': 'A ramp over an open length is written as a range.',
    'cues-dropped': 'Texts during a step are not written.',
    'intensity-approximated': 'This format has fewer intensities; some are written as the nearest.',
    'max-effort-open': 'An all-out step becomes a step without a target.',
    'flat-road-dropped': '“Flat road” of a free ride is not written.',
    'value-rounded': 'Values are rounded to whole numbers.',
    'no-power': 'The workout has no step with a power target.',
  } as Record<string, string>,
  warningFallback: 'Something is changed in this format.',
};

export type Messages = typeof en;
