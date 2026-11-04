// SPDX-License-Identifier: AGPL-3.0-or-later

type Numeric = ArrayLike<number>;

export function median(values: Numeric): number {
  return quantile(values, 0.5);
}

export function quantile(values: Numeric, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return (sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (position - low);
}

/** Median absolute deviation, scaled to match the standard deviation of normal data. */
export function mad(values: Numeric, center = median(values)): number {
  const deviations = Float64Array.from(values, (v) => Math.abs(v - center));
  return 1.4826 * median(deviations);
}

/** Centered moving average with a window of `2 * radius + 1`, shrinking at the edges. */
export function movingAverage(values: Numeric, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  let sum = 0;
  let count = 0;
  let left = 0;
  let right = -1;
  for (let i = 0; i < values.length; i++) {
    const wantRight = Math.min(values.length - 1, i + radius);
    const wantLeft = Math.max(0, i - radius);
    while (right < wantRight) {
      right++;
      sum += values[right] as number;
      count++;
    }
    while (left < wantLeft) {
      sum -= values[left] as number;
      count--;
      left++;
    }
    out[i] = sum / count;
  }
  return out;
}

/** Sliding maximum over `[i - radius, i + radius]` with a monotonic deque, O(n). */
export function slidingMax(values: Numeric, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  const deque = new Int32Array(values.length);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < values.length; i++) {
    const wantRight = Math.min(values.length - 1, i + radius);
    while (next <= wantRight) {
      while (tail > head && (values[deque[tail - 1] as number] as number) <= (values[next] as number)) tail--;
      deque[tail++] = next++;
    }
    while ((deque[head] as number) < i - radius) head++;
    out[i] = values[deque[head] as number] as number;
  }
  return out;
}

export interface Peak {
  readonly index: number;
  readonly value: number;
}

/**
 * Local maxima above `threshold`, at least `minDistance` apart; when two peaks are closer
 * the larger one wins.
 */
export function pickPeaks(values: Numeric, threshold: number, minDistance: number): Peak[] {
  const candidates: Peak[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const v = values[i] as number;
    if (v > threshold && v >= (values[i - 1] as number) && v > (values[i + 1] as number)) {
      candidates.push({ index: i, value: v });
    }
  }
  candidates.sort((a, b) => b.value - a.value);
  const taken: Peak[] = [];
  for (const peak of candidates) {
    if (taken.every((other) => Math.abs(other.index - peak.index) >= minDistance)) taken.push(peak);
  }
  return taken.sort((a, b) => a.index - b.index);
}

/** Vertex offset in `[-0.5, 0.5]` of the parabola through three neighboring samples. */
export function parabolicOffset(left: number, center: number, right: number): number {
  const denominator = left - 2 * center + right;
  if (denominator === 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
