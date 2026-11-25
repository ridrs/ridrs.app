// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The refined stretches of a route's video (ADR 0109): `refine/refine.json` in the route's folder
 * names the video and, per stretch, its time in the video, its frames per frame of the video and its
 * file below `refine/`, a video of its own whose time 0 is the stretch's `from`.
 */

/** The refinement file's path in a route's folder. */
export const REFINE_FILE = 'refine/refine.json';
/** The folder a stretch's `file` is relative to. */
export const REFINE_FOLDER = 'refine';

export interface RefinedSegment {
  /** s of the video's time where the stretch begins (its file's time 0) and where it ends. */
  readonly from: number;
  readonly to: number;
  /** Frames of the stretch per frame of the video, from 2. */
  readonly factor: number;
  /** The stretch's video, relative to `refine/`. */
  readonly file: string;
}

export interface Refinement {
  readonly version: 1;
  /** The video it refines: the control file's `video-file-path`. */
  readonly video: string;
  /** In the order of their time; none overlaps another. */
  readonly segments: readonly RefinedSegment[];
}

const fail = (reason: string): never => {
  throw new Error(`${REFINE_FILE}: ${reason}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A path below `refine/`: relative, `/`-separated, without `.` or `..` segments. */
const isInnerPath = (path: string) =>
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** Reads `refine/refine.json`; throws with the reason where it is no refinement of version 1. */
export function parseRefinement(text: string): Refinement {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (!isRecord(json) || json.version !== 1) return fail('not a refinement of version 1');
  if (typeof json.video !== 'string' || json.video === '') return fail('names no video');
  if (!Array.isArray(json.segments)) return fail('names no stretches');
  const segments = json.segments.map((value, i): RefinedSegment => {
    if (!isRecord(value)) return fail(`stretch ${i + 1} is no object`);
    const { from, to, factor, file } = value;
    if (typeof from !== 'number' || typeof to !== 'number' || !(from >= 0) || !(to > from)) {
      return fail(`stretch ${i + 1} has no time from 0 on`);
    }
    if (typeof factor !== 'number' || !Number.isInteger(factor) || factor < 2) {
      return fail(`stretch ${i + 1} has no factor of 2 or more`);
    }
    if (typeof file !== 'string' || !isInnerPath(file))
      return fail(`stretch ${i + 1} names no file below refine/`);
    return { from, to, factor, file };
  });
  const sorted = [...segments].sort((a, b) => a.from - b.from);
  sorted.forEach((segment, i) => {
    const previous = sorted[i - 1];
    if (previous && segment.from < previous.to) fail(`stretches overlap at ${segment.from} s`);
  });
  return { version: 1, video: json.video, segments: sorted };
}
