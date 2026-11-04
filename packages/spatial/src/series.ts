// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  SpatialChannels,
  SpatialPoint,
  SpatialValue,
  SpatialWindow,
  SpatialWriteResult,
} from '@ridrs/contracts';

export interface SpatialSeriesOptions<TPoint extends SpatialPoint> {
  readonly channels: SpatialChannels<TPoint>;
}

/**
 * One series by distance: the newest window and the last revision per source. A window always
 * starts at or behind the rider, so nothing outside the newest one is kept. Values do not age:
 * nothing here depends on time.
 */
export class SpatialSeries<TPoint extends SpatialPoint> {
  private readonly channels: SpatialChannels<TPoint>;
  private window: SpatialWindow<TPoint> | undefined;
  private readonly revisions = new Map<string, number>();

  constructor(options: SpatialSeriesOptions<TPoint>) {
    this.channels = options.channels;
  }

  write(window: SpatialWindow<TPoint>): SpatialWriteResult {
    const last = this.revisions.get(window.sourceId);
    if (last !== undefined && window.revision <= last) {
      return 'outdated';
    }
    this.revisions.set(window.sourceId, window.revision);
    this.window = window;
    return 'accepted';
  }

  valueAt(distance: number): SpatialValue<TPoint> {
    const window = this.window;
    if (!window) {
      return { status: 'unavailable', distance, reason: 'no-source' };
    }
    const { sourceId, revision, samples } = window;
    const last = samples.length - 1;
    const position = (distance - window.originDistance) / window.spacing;
    if (!(position >= 0)) {
      return { status: 'unavailable', distance, reason: 'outside-window' };
    }
    const available = (value: TPoint, quality: 'sampled' | 'interpolated' | 'held') =>
      ({ status: 'available', distance, value, quality, sourceId, revision }) as const;
    const lastSample = samples[last];
    if (lastSample && position > last) {
      return available(lastSample, 'held');
    }
    const index = Math.min(Math.floor(position), last - 1);
    const from = samples[index];
    const to = samples[index + 1];
    if (!from || !to) {
      return { status: 'unavailable', distance, reason: 'outside-window' };
    }
    const fraction = position - index;
    if (fraction === 0 || fraction === 1) {
      return available(fraction === 0 ? from : to, 'sampled');
    }
    return available(this.interpolate(from, to, fraction), 'interpolated');
  }

  /** The source changed or stopped: no window and no revisions any more. */
  reset(): void {
    this.window = undefined;
    this.revisions.clear();
  }

  private interpolate(from: TPoint, to: TPoint, fraction: number): TPoint {
    const value: Record<string, number | string> = {};
    for (const key of Object.keys(this.channels) as (keyof TPoint & string)[]) {
      const a = from[key];
      const b = to[key];
      value[key] =
        this.channels[key] === 'linear' && typeof a === 'number' && typeof b === 'number'
          ? a + (b - a) * fraction
          : (a as number | string);
    }
    return value as TPoint;
  }
}
