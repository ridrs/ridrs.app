// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { ActivityState } from './activity.ts';
import type { DataSource } from './data-sources.ts';
import {
  carries,
  DRAG_ROUTE,
  DRAG_WORKOUT,
  type DragData,
  draggedWorkoutSchema,
  readDragged,
  setDragged,
} from './drag.ts';
import { type NextRide, rodeNextRide } from './next-ride.ts';
import {
  isEntryBinned,
  isRideBinned,
  keyOfRemovable,
  type TrashItem,
  withoutBinned,
} from './trash.ts';

function transfer(): DragData {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type, value) => {
      data.set(type.toLowerCase(), value);
    },
    getData: (type) => data.get(type.toLowerCase()) ?? '',
  };
}

describe('drags between plugins', () => {
  it('carries a payload from the start to the drop', () => {
    const data = transfer();
    const workout = {
      kind: 'library',
      from: 'ridrs',
      workoutId: 'w1',
      name: 'Sweet Spot',
    } as const;
    setDragged(data, DRAG_WORKOUT, workout);
    expect(carries(data, DRAG_WORKOUT)).toBe(true);
    expect(carries(data, DRAG_ROUTE)).toBe(false);
    expect(readDragged(data, DRAG_WORKOUT, draggedWorkoutSchema)).toEqual(workout);
  });

  it('reads nothing that is missing, broken or of another shape', () => {
    const data = transfer();
    expect(readDragged(data, DRAG_WORKOUT, draggedWorkoutSchema)).toBeUndefined();
    data.setData(DRAG_WORKOUT, '{not json');
    expect(readDragged(data, DRAG_WORKOUT, draggedWorkoutSchema)).toBeUndefined();
    data.setData(DRAG_WORKOUT, JSON.stringify({ kind: 'library' }));
    expect(readDragged(data, DRAG_WORKOUT, draggedWorkoutSchema)).toBeUndefined();
    expect(carries(null, DRAG_WORKOUT)).toBe(false);
  });

  it('finds a type the web view lowercased', () => {
    const data: DragData = {
      types: [DRAG_WORKOUT.toUpperCase()],
      setData: () => {},
      getData: () => '',
    };
    expect(carries(data, DRAG_WORKOUT)).toBe(true);
  });
});

describe('a finished ride and the next ride', () => {
  const world = { landscape: 'demo/landscape', route: 'short-loop' };
  const workout = {
    workout: { name: 'Sweet Spot' },
    library: { from: 'ridrs', workoutId: 'w1' },
  } as unknown as NonNullable<Extract<ActivityState, { state: 'finished' }>['workout']>;
  const finished = (
    extra: Partial<Extract<ActivityState, { state: 'finished' }>>,
  ): ActivityState => ({
    state: 'finished',
    sessionId: 's1',
    startedAt: 0,
    endedAt: 1,
    ...extra,
  });
  const next: NextRide = {
    workout: { kind: 'library', from: 'ridrs', workoutId: 'w1', name: 'Sweet Spot' },
    route: { offer: 'demo/short-loop', world, title: 'Short loop' },
  };

  it('is ridden when the workout and the route were', () => {
    expect(rodeNextRide(next, finished({ world, workout }))).toBe(true);
  });

  it('is not ridden with another route, without the workout, or before the ride finished', () => {
    expect(rodeNextRide(next, finished({ world: { ...world, route: 'other' }, workout }))).toBe(
      false,
    );
    expect(rodeNextRide(next, finished({ world }))).toBe(false);
    expect(
      rodeNextRide(next, {
        state: 'paused',
        sessionId: 's1',
        startedAt: 0,
        pausedAt: 1,
        reason: 'interrupted',
        world,
        workout,
      }),
    ).toBe(false);
  });

  it('asks only for what it holds, and an empty one is never ridden', () => {
    expect(rodeNextRide({ route: next.route }, finished({ world }))).toBe(true);
    expect(rodeNextRide({ workout: next.workout }, finished({ workout }))).toBe(true);
    expect(rodeNextRide({}, finished({ world, workout }))).toBe(false);
  });

  it('matches a planned workout by its entry', () => {
    const planned: NextRide = {
      workout: {
        kind: 'planned',
        from: 'intervals.icu',
        id: 'e7',
        name: 'Threshold',
        date: '2026-11-05',
      },
    };
    const ridden = { ...workout, planned: { provider: 'intervals.icu', id: 'e7' } };
    expect(rodeNextRide(planned, finished({ workout: ridden }))).toBe(true);
    expect(rodeNextRide(planned, finished({ workout }))).toBe(false);
  });
});

describe('the bin', () => {
  const entry: TrashItem = {
    item: {
      kind: 'calendar-entry',
      provider: 'intervals.icu',
      id: 'e7',
      title: 'Threshold',
      date: '2026-11-05',
    },
    binnedAt: 1,
  };
  const ride: TrashItem = {
    item: {
      kind: 'done-ride',
      removals: [
        { provider: 'ridrs', id: 'r1' },
        { provider: 'intervals.icu', id: 'i9' },
      ],
      title: 'Monday Spin',
      date: '2026-11-02',
    },
    binnedAt: 2,
  };
  const bin = new Map([
    [keyOfRemovable(entry.item), entry],
    [keyOfRemovable(ride.item), ride],
  ]);

  it('keys an item by its kind, provider and id', () => {
    expect(keyOfRemovable(entry.item)).toBe('calendar-entry:intervals.icu:e7');
    expect(keyOfRemovable(ride.item)).toBe('done-ride:ridrs:r1');
  });

  it('knows a binned entry and a binned ride under every provider that has it', () => {
    expect(isEntryBinned(bin, 'intervals.icu', 'e7')).toBe(true);
    expect(isEntryBinned(bin, 'ridrs', 'e7')).toBe(false);
    expect(isRideBinned(bin, 'intervals.icu', 'i9')).toBe(true);
    expect(isRideBinned(bin, 'ridrs', 'r1')).toBe(true);
    expect(isRideBinned(bin, 'ridrs', 'r2')).toBe(false);
  });

  it('leaves the binned entries out of the calendars', () => {
    const source: DataSource<{ workouts: { id: string }[] }> = {
      provider: 'intervals.icu',
      label: 'intervals.icu',
      status: 'ready',
      writable: true,
      data: { workouts: [{ id: 'e7' }, { id: 'e8' }] },
    };
    const shown = withoutBinned(new Map([['intervals.icu', source]]), bin);
    expect(shown.get('intervals.icu')?.data?.workouts).toEqual([{ id: 'e8' }]);
  });
});
