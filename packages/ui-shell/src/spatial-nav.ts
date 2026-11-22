// SPDX-License-Identifier: AGPL-3.0-or-later

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface Projected {
  readonly mainStart: number;
  readonly mainEnd: number;
  readonly mainCenter: number;
  readonly crossStart: number;
  readonly crossEnd: number;
  readonly crossCenter: number;
}

/** Subpixel rounding / touching-edge tolerance in CSS pixels. */
const EDGE_EPSILON = 2;
/** Weight penalising cross-axis displacement outside the directional corridor. */
const ORTHOGONAL_WEIGHT = 3;
/** Small tie-breaker preferring better cross-axis centre alignment inside the corridor. */
const CENTER_WEIGHT = 0.15;
/** Scores closer than this are treated as tied and broken by reading order. */
const SCORE_TIE_EPSILON = 0.5;

/** Plain snapshot of an element's viewport rectangle. */
export function snapshotRect(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** Whether a rectangle has non-zero visual geometry (absent in headless DOMs without layout). */
export function hasUsableRect(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/** Rotates `rect` so that increasing `main` always points along `direction`. */
function project(rect: Rect, direction: Direction): Projected {
  switch (direction) {
    case 'right':
      return {
        mainStart: rect.left,
        mainEnd: rect.right,
        mainCenter: (rect.left + rect.right) / 2,
        crossStart: rect.top,
        crossEnd: rect.bottom,
        crossCenter: (rect.top + rect.bottom) / 2,
      };
    case 'left':
      return {
        mainStart: -rect.right,
        mainEnd: -rect.left,
        mainCenter: -(rect.left + rect.right) / 2,
        crossStart: rect.top,
        crossEnd: rect.bottom,
        crossCenter: (rect.top + rect.bottom) / 2,
      };
    case 'down':
      return {
        mainStart: rect.top,
        mainEnd: rect.bottom,
        mainCenter: (rect.top + rect.bottom) / 2,
        crossStart: rect.left,
        crossEnd: rect.right,
        crossCenter: (rect.left + rect.right) / 2,
      };
    case 'up':
      return {
        mainStart: -rect.bottom,
        mainEnd: -rect.top,
        mainCenter: -(rect.top + rect.bottom) / 2,
        crossStart: rect.left,
        crossEnd: rect.right,
        crossCenter: (rect.left + rect.right) / 2,
      };
  }
}

/**
 * Picks the best candidate in `direction` from `origin` using a W3C-style spatial distance metric:
 * candidates in the directional corridor (overlapping along the cross axis) are strongly favoured,
 * while diagonal candidates strictly ahead along the movement axis remain reachable so the focus
 * can never get trapped on isolated controls. Ties break deterministically by `candidates` order.
 */
export function findSpatialCandidate<T extends Element>(
  origin: Rect,
  candidates: readonly T[],
  direction: Direction,
  exclude?: Element,
): T | undefined {
  if (!hasUsableRect(origin)) {
    return undefined;
  }
  const from = project(origin, direction);
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === exclude) {
      continue;
    }
    const rect = snapshotRect(candidate);
    if (!hasUsableRect(rect)) {
      continue;
    }
    const to = project(rect, direction);
    const overlap = Math.min(from.crossEnd, to.crossEnd) - Math.max(from.crossStart, to.crossStart);

    const strictlyAhead =
      to.mainStart >= from.mainEnd - EDGE_EPSILON && to.mainCenter > from.mainCenter + 0.5;
    const advancingInCorridor =
      overlap > 0 && to.mainCenter > from.mainCenter + 1 && to.mainEnd > from.mainEnd + 1;
    if (!strictlyAhead && !advancingInCorridor) {
      continue;
    }

    const dMain =
      to.mainStart >= from.mainEnd
        ? to.mainStart - from.mainEnd
        : Math.max(0, to.mainCenter - from.mainCenter);
    const edgeCrossGap =
      overlap > 0 ? 0 : Math.max(from.crossStart - to.crossEnd, to.crossStart - from.crossEnd);
    const centerCrossDiff = Math.abs(to.crossCenter - from.crossCenter);
    const score = dMain + ORTHOGONAL_WEIGHT * edgeCrossGap + CENTER_WEIGHT * centerCrossDiff;

    if (score < bestScore - SCORE_TIE_EPSILON) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/**
 * Picks the spatially closest candidate to `origin` in any direction: used when a focused element
 * disappeared and no remaining control lies strictly in the pressed direction, so navigation stays
 * near the vanished control instead of jumping back to the top of the screen.
 */
export function findNearestSpatial<T extends Element>(
  origin: Rect,
  candidates: readonly T[],
  exclude?: Element,
): T | undefined {
  if (!hasUsableRect(origin)) {
    return undefined;
  }
  const ox = (origin.left + origin.right) / 2;
  const oy = (origin.top + origin.bottom) / 2;
  let best: T | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === exclude) {
      continue;
    }
    const rect = snapshotRect(candidate);
    if (!hasUsableRect(rect)) {
      continue;
    }
    const dx = Math.max(origin.left - rect.right, rect.left - origin.right, 0);
    const dy = Math.max(origin.top - rect.bottom, rect.top - origin.bottom, 0);
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const score = Math.hypot(dx, dy) + 0.05 * Math.hypot(cx - ox, cy - oy);
    if (score < bestScore - SCORE_TIE_EPSILON) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/** True when at least one candidate (besides `exclude`) has non-zero layout geometry. */
export function hasSpatialCandidates(candidates: readonly Element[], exclude?: Element): boolean {
  for (const candidate of candidates) {
    if (candidate !== exclude && hasUsableRect(snapshotRect(candidate))) {
      return true;
    }
  }
  return false;
}
