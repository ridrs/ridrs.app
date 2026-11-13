// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@ridrs/ride`: the `.ride` package of a video route (ADR 0094), an Incyclist package. Reads and
 * writes its control file, finds its picture and tells whether a ZIP's entries make one. Pure and
 * headless: no clock, no I/O.
 */
export * from './control.ts';
export * from './package.ts';
