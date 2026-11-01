// SPDX-License-Identifier: AGPL-3.0-or-later

// Measuring-only shim for the stage 3 probe: there are no file paths to import from in a WebView.
export function pathToFileURL(path: string): URL {
  throw new Error(`pathToFileURL(${path}) has no meaning in a WebView`);
}
