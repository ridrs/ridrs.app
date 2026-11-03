// SPDX-License-Identifier: AGPL-3.0-or-later

/** Where recordings and their exports live, relative to the app's data directory. */
export const RECORDINGS_DIRECTORY = 'recordings';

export const RECORDING_EXTENSION = '.ridrs';
export const OPEN_RECORDING_EXTENSION = '.ridrs.jsonl';
export const FIT_EXTENSION = '.fit';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** `ride-<startedAt as UTC yyyyMMdd'T'HHmmss'Z'>-<first 8 chars of the session id>`. */
export function recordingName(startedAt: number, sessionId: string): string {
  const d = new Date(startedAt);
  const stamp =
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `ride-${stamp}-${sessionId.slice(0, 8)}`;
}

export function openRecordingPath(name: string): string {
  return `${RECORDINGS_DIRECTORY}/${name}${OPEN_RECORDING_EXTENSION}`;
}

export function recordingPath(name: string): string {
  return `${RECORDINGS_DIRECTORY}/${name}${RECORDING_EXTENSION}`;
}

/** `recordings/x.ridrs` or `recordings/x.ridrs.jsonl` -> `recordings/x.fit`. */
export function fitPathFor(path: string): string {
  return `${path.replace(/\.ridrs(\.jsonl)?$/, '')}${FIT_EXTENSION}`;
}

/** The file name without its directory. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
