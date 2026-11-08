// SPDX-License-Identifier: AGPL-3.0-or-later

import { athleteProfileSchema, plannedWorkoutSchema } from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { localDate, toAthlete, toSteps, toWorkouts } from './intervals.ts';
import { codeChallenge, randomUnreserved } from './pkce.ts';

describe('toAthlete', () => {
  it('takes the name, the weight and the cycling settings, the indoor FTP first', () => {
    const athlete = toAthlete({
      name: 'Alex Rider',
      icu_weight: 72,
      sportSettings: [
        { types: ['Run'], ftp: null, lthr: 170 },
        { types: ['Ride', 'VirtualRide'], ftp: 260, indoor_ftp: 250, lthr: 165, max_hr: 185 },
      ],
    });
    expect(athlete).toEqual({ name: 'Alex Rider', ftp: 250, weight: 72, lthr: 165, maxHeartRate: 185 });
    expect(athleteProfileSchema.parse(athlete)).toEqual(athlete);
  });

  it('leaves out what is missing or invalid', () => {
    expect(toAthlete({ name: 'A', icu_weight: -1, sportSettings: [{ types: ['Ride'], ftp: 0 }] })).toEqual({
      name: 'A',
    });
    expect(toAthlete(null)).toEqual({});
  });

  it("prefers today's wellness weight to the weight of the athlete", () => {
    expect(toAthlete({ icu_weight: 72 }, 71.2)).toEqual({ weight: 71.2 });
    expect(toAthlete({ icu_weight: 72 }, undefined)).toEqual({ weight: 72 });
    expect(toAthlete({ icu_weight: 72 }, 0)).toEqual({ weight: 72 });
  });
});

describe('toWorkouts', () => {
  const event = (fields: Record<string, unknown>) => ({
    id: 1,
    category: 'WORKOUT',
    type: 'Ride',
    name: 'Tempo',
    start_date_local: '2026-11-04T00:00:00',
    ...fields,
  });

  it('keeps planned rides in date order and drops other sports and categories', () => {
    const workouts = toWorkouts(
      [
        event({ id: 3, start_date_local: '2026-11-06T00:00:00', type: 'VirtualRide', name: 'B' }),
        event({ id: 2, type: 'Run' }),
        event({ id: 4, category: 'NOTE' }),
        event({ id: 1, name: 'A', moving_time: 3600, icu_training_load: 60, description: 'Go' }),
      ],
      250,
    );
    expect(workouts).toEqual([
      {
        id: '1',
        date: '2026-11-04',
        name: 'A',
        sport: 'ride',
        description: 'Go',
        durationSeconds: 3600,
        trainingLoad: 60,
        steps: [],
      },
      { id: '3', date: '2026-11-06', name: 'B', sport: 'virtual-ride', steps: [] },
    ]);
    for (const workout of workouts) {
      expect(plannedWorkoutSchema.parse(workout)).toEqual(workout);
    }
  });
});

describe('toSteps', () => {
  it('maps targets in % FTP to watts, ramps, phases and repeats', () => {
    const steps = toSteps(
      [
        { duration: 600, warmup: true, ramp: true, power: { units: '%ftp', start: 50, end: 75 } },
        {
          reps: 3,
          steps: [
            { duration: 720, power: { units: '%ftp', value: 90 }, cadence: { value: 95 } },
            { duration: 240, power: { units: '%ftp', value: 55 }, text: 'Easy' },
          ],
        },
        { duration: 300, cooldown: true, power: { units: 'w', start: 150, end: 100 } },
      ],
      250,
    );
    expect(steps).toEqual([
      {
        kind: 'interval',
        durationSeconds: 600,
        phase: 'warm-up',
        power: { low: 50, high: 75, lowWatts: 125, highWatts: 188 },
      },
      {
        kind: 'repeat',
        reps: 3,
        steps: [
          {
            kind: 'interval',
            durationSeconds: 720,
            power: { low: 90, high: 90, lowWatts: 225, highWatts: 225 },
            cadence: { low: 95, high: 95 },
          },
          {
            kind: 'interval',
            durationSeconds: 240,
            text: 'Easy',
            power: { low: 55, high: 55, lowWatts: 138, highWatts: 138 },
          },
        ],
      },
      {
        kind: 'interval',
        durationSeconds: 300,
        phase: 'cool-down',
        power: { low: 60, high: 40, lowWatts: 150, highWatts: 100 },
      },
    ]);
  });

  it('keeps % FTP without watts when the FTP is unknown, and drops targets it cannot convert', () => {
    expect(
      toSteps(
        [
          { duration: 60, power: { units: '%ftp', value: 100 } },
          { duration: 60, power: { units: 'w', value: 200 } },
          { duration: 60, power: { units: 'power_zone', value: 2 } },
          { power: { units: '%ftp', value: 100 } },
        ],
        undefined,
      ),
    ).toEqual([
      { kind: 'interval', durationSeconds: 60, power: { low: 100, high: 100 } },
      { kind: 'interval', durationSeconds: 60 },
      { kind: 'interval', durationSeconds: 60 },
    ]);
  });
});

describe('localDate', () => {
  it('names the local day and counts days on the calendar', () => {
    const morning = new Date(2026, 10, 4, 8, 0).getTime();
    expect(localDate(morning)).toBe('2026-11-04');
    expect(localDate(morning, 13)).toBe('2026-11-17');
    expect(localDate(new Date(2026, 11, 31, 23, 59).getTime(), 1)).toBe('2027-01-01');
  });
});

describe('PKCE', () => {
  it('makes verifiers from the unreserved alphabet', () => {
    const verifier = randomUnreserved(64);
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{64}$/);
    expect(randomUnreserved(64)).not.toBe(verifier);
  });

  it('derives the S256 challenge of RFC 7636', async () => {
    // RFC 7636, appendix B.
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
