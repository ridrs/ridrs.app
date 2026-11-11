// SPDX-License-Identifier: AGPL-3.0-or-later

export { exportErg, exportMrc } from './course.ts';
export { exportFit } from './fit.ts';
/** The exporters (structured-workouts.md, section 9): pure, headless, warning where a format falls short. */
export {
  exportIntervalsDoc,
  INTERVALS_DOC_INTENSITIES,
  INTERVALS_DOC_UNITS,
  type IntervalsDocExport,
  type IntervalsWorkoutDoc,
} from './intervals-doc.ts';
export { exportIntervalsText, type IntervalsTextExport } from './intervals-text.ts';
export type { WorkoutExport, WorkoutExportOptions } from './shared.ts';
export { exportTcx } from './tcx.ts';
export { exportZwo } from './zwo.ts';
