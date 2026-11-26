// SPDX-License-Identifier: AGPL-3.0-or-later

/** Where recordings and their exports live, relative to the app's data directory. */
export const RECORDINGS_DIRECTORY = 'recordings';

export const RECORDING_EXTENSION = '.ridrs';
export const OPEN_RECORDING_EXTENSION = '.ridrs.jsonl';
export const FIT_EXTENSION = '.fit';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** `<startedAt as UTC yyyyMMdd'T'HHmmss'Z'>`. */
function utcStamp(startedAt: number): string {
  const d = new Date(startedAt);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * `ride-<startedAt as UTC yyyyMMdd'T'HHmmss'Z'>-<first 8 chars of the session id>`: the name of a
 * running ride's open recording. Sealed, it is named after its summary (`ridePath`, ADR 0111).
 */
export function recordingName(startedAt: number, sessionId: string): string {
  return `ride-${utcStamp(startedAt)}-${sessionId.slice(0, 8)}`;
}

export function openRecordingPath(name: string): string {
  return `${RECORDINGS_DIRECTORY}/${name}${OPEN_RECORDING_EXTENSION}`;
}

/** `recordings/x.ridrs` or `recordings/x.ridrs.jsonl` -> `recordings/x.fit`. */
export function fitPathFor(path: string): string {
  return `${path.replace(/\.ridrs(\.jsonl)?$/, '')}${FIT_EXTENSION}`;
}

/** The file name without its directory. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export const SCREENSHOT_EXTENSION = '.jpg';

/**
 * Where the next screenshot of the ride started at `startedAt` goes (ADR 0102), given the app
 * files in the recordings: `recordings/ride-<stamp>-screenshot_<NN>.jpg`, numbered from 00, the
 * number after the highest one of this ride.
 */
export function screenshotPath(startedAt: number, existing: readonly string[]): string {
  const prefix = `ride-${utcStamp(startedAt)}-screenshot_`;
  let next = 0;
  for (const path of existing) {
    const name = fileNameOf(path);
    if (!name.startsWith(prefix) || !name.endsWith(SCREENSHOT_EXTENSION)) continue;
    const number = name.slice(prefix.length, -SCREENSHOT_EXTENSION.length);
    if (/^\d+$/.test(number)) next = Math.max(next, Number(number) + 1);
  }
  return `${RECORDINGS_DIRECTORY}/${prefix}${pad(next)}${SCREENSHOT_EXTENSION}`;
}
