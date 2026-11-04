// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SpatialWindow, TerrainPoint } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { SpatialSeries } from './series.ts';

const TERRAIN = { channels: { gradient: 'linear', surface: 'step' } } as const;

function window(
  originDistance: number,
  samples: readonly (readonly [number, TerrainPoint['surface']])[],
  { revision = 1, sourceId = 'world', spacing = 1 } = {},
): SpatialWindow<TerrainPoint> {
  return {
    sourceId,
    revision,
    originDistance,
    spacing,
    samples: samples.map(([gradient, surface]) => ({ gradient, surface })),
  };
}

function terrain() {
  return new SpatialSeries<TerrainPoint>(TERRAIN);
}

describe('SpatialSeries', () => {
  it('is unavailable without a window', () => {
    expect(terrain().valueAt(0)).toEqual({
      status: 'unavailable',
      distance: 0,
      reason: 'no-source',
    });
  });

  it('gives a sample exactly at its distance', () => {
    const series = terrain();
    series.write(
      window(
        10,
        [
          [0.01, 'asphalt'],
          [0.03, 'gravel'],
        ],
        { spacing: 5 },
      ),
    );
    expect(series.valueAt(15)).toEqual({
      status: 'available',
      distance: 15,
      value: { gradient: 0.03, surface: 'gravel' },
      quality: 'sampled',
      sourceId: 'world',
      revision: 1,
    });
  });

  it('interpolates a linear channel and steps a categorical one', () => {
    const series = terrain();
    series.write(
      window(
        0,
        [
          [0, 'asphalt'],
          [0.1, 'gravel'],
        ],
        { spacing: 10 },
      ),
    );
    const value = series.valueAt(7.5);
    expect(value).toMatchObject({ status: 'available', quality: 'interpolated' });
    if (value.status !== 'available') {
      throw new Error('expected a value');
    }
    expect(value.value.gradient).toBeCloseTo(0.075, 12);
    // The surface of a sample holds until the next one.
    expect(value.value.surface).toBe('asphalt');
  });

  it('interpolates exactly like the former integrator lookup', () => {
    const series = terrain();
    series.write(
      window(99, [
        [0, 'asphalt'],
        [0.05, 'asphalt'],
      ]),
    );
    const value = series.valueAt(99.3);
    expect(value.status === 'available' && value.value.gradient).toBe(0 + (0.05 - 0) * (99.3 - 99));
  });

  it('holds the last sample beyond the end of the window', () => {
    const series = terrain();
    series.write(
      window(0, [
        [0, 'asphalt'],
        [0.05, 'gravel'],
      ]),
    );
    expect(series.valueAt(1000)).toMatchObject({
      status: 'available',
      quality: 'held',
      value: { gradient: 0.05, surface: 'gravel' },
    });
  });

  it('is unavailable behind the origin of the window', () => {
    const series = terrain();
    series.write(
      window(20, [
        [0, 'asphalt'],
        [0, 'asphalt'],
      ]),
    );
    expect(series.valueAt(19.99)).toEqual({
      status: 'unavailable',
      distance: 19.99,
      reason: 'outside-window',
    });
  });

  it('replaces the range a newer window covers and keeps nothing outside it', () => {
    const series = terrain();
    series.write(
      window(0, [
        [0, 'asphalt'],
        [0, 'asphalt'],
        [0, 'asphalt'],
      ]),
    );
    expect(
      series.write(
        window(
          1,
          [
            [0.05, 'gravel'],
            [0.05, 'gravel'],
          ],
          { revision: 2 },
        ),
      ),
    ).toBe('accepted');
    expect(series.valueAt(1)).toMatchObject({ value: { gradient: 0.05 }, revision: 2 });
    expect(series.valueAt(0.5)).toMatchObject({ status: 'unavailable', reason: 'outside-window' });
  });

  it('ignores an older or equal revision from the same source', () => {
    const series = terrain();
    series.write(
      window(
        0,
        [
          [0.05, 'asphalt'],
          [0.05, 'asphalt'],
        ],
        { revision: 3 },
      ),
    );
    expect(
      series.write(
        window(
          0,
          [
            [0, 'asphalt'],
            [0, 'asphalt'],
          ],
          { revision: 3 },
        ),
      ),
    ).toBe('outdated');
    expect(
      series.write(
        window(
          0,
          [
            [0, 'asphalt'],
            [0, 'asphalt'],
          ],
          { revision: 2 },
        ),
      ),
    ).toBe('outdated');
    expect(series.valueAt(0)).toMatchObject({ value: { gradient: 0.05 }, revision: 3 });
  });

  it('counts revisions per source', () => {
    const series = terrain();
    series.write(
      window(
        0,
        [
          [0.05, 'asphalt'],
          [0.05, 'asphalt'],
        ],
        { revision: 3, sourceId: 'a' },
      ),
    );
    expect(
      series.write(
        window(
          0,
          [
            [0, 'gravel'],
            [0, 'gravel'],
          ],
          { revision: 1, sourceId: 'b' },
        ),
      ),
    ).toBe('accepted');
    expect(series.valueAt(0)).toMatchObject({ value: { surface: 'gravel' }, sourceId: 'b' });
  });

  it('reads ahead as far as the window goes', () => {
    const series = terrain();
    series.write(
      window(
        0,
        Array.from({ length: 21 }, (_, d) => [d / 100, 'asphalt'] as const),
      ),
    );
    expect(series.valueAt(20)).toMatchObject({ quality: 'sampled', value: { gradient: 0.2 } });
  });

  it('forgets everything on reset', () => {
    const series = terrain();
    series.write(
      window(
        0,
        [
          [0, 'asphalt'],
          [0, 'asphalt'],
        ],
        { revision: 5 },
      ),
    );
    series.reset();
    expect(series.valueAt(0)).toMatchObject({ status: 'unavailable', reason: 'no-source' });
    expect(
      series.write(
        window(
          0,
          [
            [0, 'asphalt'],
            [0, 'asphalt'],
          ],
          { revision: 1 },
        ),
      ),
    ).toBe('accepted');
  });
});
