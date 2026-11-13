// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@ridrs/ride`: the `.ride` package of a video route (ADR 0094), an Incyclist package. Reads and
 * writes its control file, finds its picture and tells whether a ZIP's entries make one; finds the
 * control file of a route's folder and moves a route of the unified format to one. Headless: no
 * clock, and no I/O but through the `storage.media` it is given.
 */
export * from './control.ts';
export * from './folder.ts';
export * from './package.ts';
