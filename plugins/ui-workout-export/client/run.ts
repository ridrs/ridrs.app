// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AthleteProfile,
  type DataSource,
  type DataSourceChoice,
  DEFAULT_PROVIDER,
  type LibraryWorkout,
  WORKOUT_FORMAT,
  WORKOUT_FORMAT_VERSION,
  type UiCapabilityInput,
  type Workout,
  type WorkoutSourceFormat,
  workoutExportCapability,
} from '@ridrs/contracts';
import {
  exportErg,
  exportFit,
  exportIntervalsText,
  exportMrc,
  exportTcx,
  exportZwo,
  type WorkoutDiagnostic,
} from '@ridrs/workout';

/** The formats of an export, in the order the screen offers them. */
export const EXPORT_FORMATS = ['zwo', 'fit', 'erg', 'mrc', 'tcx', 'intervals'] as const;

/** How each format is saved: the file extension and the media type. */
export const FILE_KINDS: Record<WorkoutSourceFormat, { extension: string; mediaType: string }> = {
  zwo: { extension: 'zwo', mediaType: 'application/xml' },
  fit: { extension: 'fit', mediaType: 'application/octet-stream' },
  erg: { extension: 'erg', mediaType: 'text/plain' },
  mrc: { extension: 'mrc', mediaType: 'text/plain' },
  tcx: { extension: 'tcx', mediaType: 'application/vnd.garmin.tcx+xml' },
  intervals: { extension: 'txt', mediaType: 'text/plain' },
};

/** A provider's library as the app state holds it (ADR 0075). */
export type Library = DataSource<{ readonly workouts: readonly LibraryWorkout[] }>;

/** Which workout to export: a library and its workout (the capability's input). */
export type ExportSubject = UiCapabilityInput<typeof workoutExportCapability>;

export type Found =
  | { readonly state: 'shown'; readonly workout: Workout }
  | { readonly state: 'loading' }
  | { readonly state: 'missing' };

/** The canonical workout of a library entry; an entry that has only steps is made one. */
function fromEntry(entry: LibraryWorkout): Workout {
  return {
    format: WORKOUT_FORMAT,
    version: WORKOUT_FORMAT_VERSION,
    id: entry.id,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    sport: entry.sport,
    source: { kind: 'provider' },
    steps: [...entry.steps],
  };
}

/** Finds the library workout to export in the app state. */
export function subjectOf(
  subject: ExportSubject,
  libraries: ReadonlyMap<string, Library>,
): Found {
  const library = libraries.get(subject.from);
  const entry = library?.data?.workouts.find((workout) => workout.id === subject.workoutId);
  if (entry) return { state: 'shown', workout: entry.workout ?? fromEntry(entry) };
  const pending = !library || (library.data === undefined && library.status === 'loading');
  return pending ? { state: 'loading' } : { state: 'missing' };
}

/** The FTP of the chosen profile source (`ridrs` without a choice), the only thing an export reads. */
export function chosenFtp(
  profiles: ReadonlyMap<string, DataSource<AthleteProfile>>,
  choices: ReadonlyMap<string, DataSourceChoice>,
): number | undefined {
  const provider = choices.get('athlete.profile')?.provider ?? DEFAULT_PROVIDER;
  return profiles.get(provider)?.data?.ftp;
}

/** A file name from a workout's name: ASCII, lower case, words joined by hyphens. */
export function fileNameOf(workout: Workout, format: WorkoutSourceFormat): string {
  const slug = workout.name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'workout'}.${FILE_KINDS[format].extension}`;
}

export type Prepared =
  | {
      readonly ok: true;
      readonly fileName: string;
      readonly mediaType: string;
      /** The file as base64, what `files.save` takes. */
      readonly data: string;
      readonly warnings: readonly WorkoutDiagnostic[];
    }
  | { readonly ok: false; readonly reason: readonly WorkoutDiagnostic[] };

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

/** Exports the workout to a format: the file, ready to save, with its warnings, or why not. */
export function prepareExport(
  workout: Workout,
  format: WorkoutSourceFormat,
  ftp: number | undefined,
): Prepared {
  const options = ftp === undefined ? {} : { ftp };
  const result =
    format === 'intervals'
      ? (() => {
          const { text, diagnostics } = exportIntervalsText(workout);
          return { ok: true as const, data: text, diagnostics };
        })()
      : { zwo: exportZwo, fit: exportFit, erg: exportErg, mrc: exportMrc, tcx: exportTcx }[format](
          workout,
          options,
        );
  if (!result.ok) return { ok: false, reason: result.diagnostics };
  const bytes = typeof result.data === 'string' ? new TextEncoder().encode(result.data) : result.data;
  return {
    ok: true,
    fileName: fileNameOf(workout, format),
    mediaType: FILE_KINDS[format].mediaType,
    data: toBase64(bytes),
    warnings: result.diagnostics,
  };
}
