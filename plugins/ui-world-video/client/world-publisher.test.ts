// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PresentedPhysics } from '@ridrs/presentation';
import { describe, expect, it } from 'vitest';
import { buildTrack } from './track.ts';
import { type ObservedPosition, POSITION_SPACING, type TerrainWindow, WorldPublisher } from './world-publisher.ts';

// About 1.1 km due north, climbing 55 m: 5 %.
const TRACK = buildTrack([
  { latitude: 45, longitude: 5, elevation: 100, time: 0 },
  { latitude: 45.01, longitude: 5, elevation: 100 + 0.05 * 1111.95, time: 300 },
]);

function publisher() {
  const terrain: TerrainWindow[] = [];
  const positions: ObservedPosition[] = [];
  const subject = new WorldPublisher(TRACK, {
    terrain: (window) => terrain.push(window),
    position: (position) => positions.push(position),
  });
  return { subject, terrain, positions };
}

const shown = (distance: number, sessionId = 's-1'): PresentedPhysics => ({
  status: 'available',
  renderTime: 0,
  basis: 'interpolated',
  sessionId,
  step: 1,
  speed: 5,
  distance,
  acceleration: 0,
  gradient: 0,
});

describe('WorldPublisher', () => {
  it("publishes the route's terrain from 0 m on mount, on a 1 m grid", () => {
    const { subject, terrain, positions } = publisher();
    subject.mount();
    expect(terrain).toHaveLength(1);
    expect(terrain[0]).toMatchObject({ revision: 1, originDistance: 0, spacing: 1 });
    expect(terrain[0]?.samples).toHaveLength(21);
    expect(terrain[0]?.samples[15]?.gradient).toBeCloseTo(0.05, 3);
    expect(positions).toEqual([]);
  });

  it('publishes a new window once less than 10 m are left, from the grid point at or before', () => {
    const { subject, terrain } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-1', startedAt: 0 });
    subject.mount();
    subject.frame(shown(10));
    subject.frame(shown(10.4));
    expect(terrain.map((w) => [w.revision, w.originDistance])).toEqual([
      [1, 0],
      [2, 10],
    ]);
  });

  it(`tells where the rider is at the first frame and every ${POSITION_SPACING} m`, () => {
    const { subject, positions } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-1', startedAt: 0 });
    subject.mount();
    for (const distance of [0, 1, 4.9, 5, 7, 10.2]) {
      subject.frame(shown(distance));
    }
    expect(positions.map((p) => p.distance)).toEqual([0, 5, 10.2]);
    expect(positions[0]).toEqual({ distance: 0, latitude: 45, longitude: 5, altitude: 100 });
    expect(positions[2]?.latitude).toBeCloseTo(45 + (0.01 * 10.2) / TRACK.length, 9);
  });

  it('publishes nothing at standstill, outside a ride or for another ride', () => {
    const { subject, terrain, positions } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-2', startedAt: 0 });
    subject.mount();
    subject.frame(shown(500, 's-1'));
    subject.frame({ status: 'none', renderTime: 0 });
    subject.frame(shown(3, 's-2'));
    for (let frame = 0; frame < 100; frame += 1) {
      subject.frame(shown(3, 's-2'));
    }
    subject.rideState({ state: 'paused', sessionId: 's-2', startedAt: 0, pausedAt: 1, reason: 'rider' });
    subject.frame(shown(300, 's-2'));
    expect(terrain).toHaveLength(1);
    expect(positions.map((p) => p.distance)).toEqual([3]);
  });
});
