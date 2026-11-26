// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When a route's refinement (ADR 0110) is likely done: from the share done when it was first seen
 * refining and the share done now, at the pace between the two. Wall-clock time of the rendering
 * only: nothing in a ride depends on it (AGENTS.md rule 7 is about simulation code).
 */

/** A share of the refinement done, and when it was seen (ms since the epoch). */
export interface RefinementSample {
  readonly at: number;
  readonly progress: number;
}

/** No estimate before this much of the refinement and this much time have passed since the first sample. */
const MIN_SHARE = 0.01;
const MIN_TIME_MS = 15_000;

/** When the refinement is likely done (ms since the epoch), or `undefined` while too little has passed to say. */
export function estimateEnd(first: RefinementSample, now: RefinementSample): number | undefined {
  const share = now.progress - first.progress;
  const time = now.at - first.at;
  if (share < MIN_SHARE || time < MIN_TIME_MS) return undefined;
  return now.at + ((1 - now.progress) * time) / share;
}
