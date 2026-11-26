// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { rideOf } from './index.ts';

describe('rideOf', () => {
  it("lists a ride on the rider's local day, under its session", () => {
    expect(
      rideOf({
        sessionId: 'run:activity-session:1:0',
        startedAt: Date.UTC(2026, 10, 24, 23, 30, 0, 0),
        timeZoneOffsetMinutes: 60,
        durationSeconds: 600,
        planned: { provider: 'intervals', id: 'evt-7' },
        name: 'Sweet Spot',
      }),
    ).toEqual({
      id: 'run:activity-session:1:0',
      date: '2026-11-25',
      startedAt: Date.UTC(2026, 10, 24, 23, 30, 0, 0),
      name: 'Sweet Spot',
      sport: 'virtual-ride',
      durationSeconds: 600,
      externalId: 'run_activity-session_1_0',
      planned: { provider: 'intervals', id: 'evt-7' },
    });
  });

  it('leaves out a duration and a plan it does not have', () => {
    const ride = rideOf({ sessionId: 's', startedAt: 0, timeZoneOffsetMinutes: -300, name: 'Ride' });
    expect(ride).toEqual({ id: 's', date: '1969-12-31', startedAt: 0, name: 'Ride', sport: 'virtual-ride', externalId: 's' });
  });
});
