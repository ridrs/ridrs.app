// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileSchema,
  completedWorkoutSchema,
  libraryWorkoutSchema,
  plannedWorkoutSchema,
  workoutSchema,
} from '@ridrs/contracts';
import { describe, expect, it } from 'vitest';
import { exportIntervalsDoc } from '@ridrs/workout';
import {
  ftpField,
  heartRateTop,
  libraryDocs,
  localDate,
  toActivities,
  toAthlete,
  toLibrary,
  toSteps,
  toWorkouts,
  zoneSettings,
} from './intervals.ts';
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

describe('ftpField', () => {
  const settings = (ride: Record<string, unknown>) => ({
    sportSettings: [{ types: ['Run'], ftp: 1 }, { types: ['Ride'], ...ride }],
  });

  it('is the field the FTP is read from: the indoor FTP where one is set, else the FTP', () => {
    expect(ftpField(settings({ ftp: 260, indoor_ftp: 250 }))).toBe('indoor_ftp');
    expect(ftpField(settings({ ftp: 260 }))).toBe('ftp');
    expect(ftpField(settings({ ftp: 0, indoor_ftp: 0 }))).toBe('ftp');
    expect(ftpField(null)).toBe('ftp');
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
  it('keeps targets in their unit, tells ramps from ranges, and nests repeats', () => {
    const steps = toSteps([
      { duration: 600, warmup: true, ramp: true, power: { units: '%ftp', start: 50, end: 75 } },
      {
        reps: 3,
        steps: [
          { duration: 720, power: { units: '%ftp', value: 90 }, cadence: { value: 95 } },
          { duration: 240, power: { units: '%ftp', value: 55 }, text: 'Easy' },
        ],
      },
      { duration: 300, cooldown: true, ramp: true, power: { units: 'w', start: 150, end: 100 } },
      { duration: 120, power: { units: 'w', start: 200, end: 220 } },
    ]);
    expect(steps).toEqual([
      {
        kind: 'interval',
        id: '1',
        intensity: 'warm-up',
        duration: { kind: 'time', seconds: 600 },
        effort: {
          kind: 'target',
          primary: { unit: 'percent-ftp', start: { low: 50, high: 50 }, end: { low: 75, high: 75 } },
        },
      },
      {
        kind: 'repeat',
        id: '2',
        until: { kind: 'count', reps: 3 },
        steps: [
          {
            kind: 'interval',
            id: '2.1',
            duration: { kind: 'time', seconds: 720 },
            effort: {
              kind: 'target',
              primary: { unit: 'percent-ftp', start: { low: 90, high: 90 } },
              secondary: [{ unit: 'rpm', start: { low: 95, high: 95 } }],
            },
          },
          {
            kind: 'interval',
            id: '2.2',
            name: 'Easy',
            duration: { kind: 'time', seconds: 240 },
            effort: { kind: 'target', primary: { unit: 'percent-ftp', start: { low: 55, high: 55 } } },
          },
        ],
      },
      {
        kind: 'interval',
        id: '3',
        intensity: 'cool-down',
        duration: { kind: 'time', seconds: 300 },
        effort: {
          kind: 'target',
          primary: { unit: 'watts', start: { low: 150, high: 150 }, end: { low: 100, high: 100 } },
        },
      },
      {
        kind: 'interval',
        id: '4',
        duration: { kind: 'time', seconds: 120 },
        effort: { kind: 'target', primary: { unit: 'watts', start: { low: 200, high: 220 } } },
      },
    ]);
  });

  it('keeps zone targets as zones, rides unknown units free (kept in the extensions), and drops steps without a duration', () => {
    expect(
      toSteps([
        { duration: 60, power: { units: 'power_zone', value: 2 } },
        { duration: 60, power: { units: '%mmp', value: 80 } },
        { power: { units: '%ftp', value: 100 } },
      ]),
    ).toEqual([
      {
        kind: 'interval',
        id: '1',
        duration: { kind: 'time', seconds: 60 },
        effort: { kind: 'target', primary: { unit: 'power-zone', start: { low: 2, high: 2 } } },
      },
      {
        kind: 'interval',
        id: '2',
        duration: { kind: 'time', seconds: 60 },
        effort: { kind: 'free' },
        extensions: { intervals: { doc: { power: { units: '%mmp', value: 80 } }, implicitFree: true } },
      },
    ]);
  });

  it('reads heart rate, distance, lap button, free ride, max effort and the intensity words', () => {
    expect(
      toSteps([
        { distance: 2000, duration: 300, hr: { units: 'bpm', start: 140, end: 150 }, intensity: 'warmup' },
        { until_lap_press: true, hr: { units: '%hr', value: 75 }, cadence: { units: 'rpm', value: 90 } },
        { duration: 300, freeride: true, cadence: { units: 'rpm', value: 85 } },
        { duration: 10, maxeffort: true, power: { units: '%ftp', value: 200 } },
        { duration: 60, power: { units: '%ftp', value: 60 }, hr: { units: 'hr_zone', value: 2 }, intensity: 'recovery' },
      ]),
    ).toEqual([
      {
        kind: 'interval',
        id: '1',
        intensity: 'warm-up',
        duration: { kind: 'distance', meters: 2000 },
        effort: { kind: 'target', primary: { unit: 'bpm', start: { low: 140, high: 150 } } },
        extensions: { intervals: { doc: { duration: 300 }, intensityAs: 'text' } },
      },
      {
        kind: 'interval',
        id: '2',
        duration: { kind: 'open' },
        effort: {
          kind: 'target',
          primary: { unit: 'percent-max-hr', start: { low: 75, high: 75 } },
          secondary: [{ unit: 'rpm', start: { low: 90, high: 90 } }],
        },
      },
      {
        kind: 'interval',
        id: '3',
        duration: { kind: 'time', seconds: 300 },
        effort: { kind: 'free', secondary: [{ unit: 'rpm', start: { low: 85, high: 85 } }] },
      },
      {
        kind: 'interval',
        id: '4',
        duration: { kind: 'time', seconds: 10 },
        effort: { kind: 'max-effort' },
        extensions: { intervals: { doc: { power: { units: '%ftp', value: 200 } } } },
      },
      {
        kind: 'interval',
        id: '5',
        intensity: 'recovery',
        duration: { kind: 'time', seconds: 60 },
        effort: {
          kind: 'target',
          primary: { unit: 'percent-ftp', start: { low: 60, high: 60 } },
          secondary: [{ unit: 'hr-zone', start: { low: 2, high: 2 } }],
        },
      },
    ]);
  });

  it('gives back the same document through exportIntervalsDoc', () => {
    const doc = {
      steps: [
        { text: 'Warm up', duration: 600, warmup: true, ramp: true, power: { units: '%ftp', start: 50, end: 75 }, _power: { start: 125, end: 188 } },
        { reps: 3, text: 'Main set 3x', steps: [
          { duration: 300, power: { units: 'w', value: 280, target: 'POWER' }, cadence: { units: 'rpm', start: 95, end: 105 } },
          { duration: 180, power: { units: 'power_zone', value: 2 }, intensity: 'rest' },
        ] },
        { duration: 60, power: { units: '%mmp', value: 80, mmp_duration: 300 }, hidepower: true },
        { duration: 300, freeride: true },
        { duration: 10, maxeffort: true },
        { distance: 5000, duration: 540, hr: { units: 'hr_zone', value: 2 } },
        { until_lap_press: true, hr: { units: '%lthr', start: 80, end: 85 }, intensity: 'cooldown' },
      ],
    };
    const workout = {
      format: 'ridrs-workout' as const,
      version: 1 as const,
      id: 'w',
      name: 'W',
      sport: 'ride' as const,
      source: { kind: 'provider' as const },
      steps: toSteps(doc.steps),
    };
    expect(workoutSchema.parse(workout)).toEqual(workout);
    const exported = exportIntervalsDoc(workout);
    expect(exported.doc).toEqual(doc);
    expect(exported.diagnostics).toEqual([]);
  });
});

describe('zones', () => {
  const athlete = {
    sportSettings: [
      {
        types: ['Ride'],
        ftp: 250,
        power_zones: [55, 75, 90, 105, 120, 150, 999],
        power_zone_names: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'],
        hr_zones: [138, 154, 190],
        hr_zone_names: ['Easy', '', 'Hard'],
      },
    ],
  };

  it('reads the Ride zones with the last one open', () => {
    const profile = toAthlete(athlete);
    expect(profile.powerZones?.at(-1)).toEqual({ name: 'Z7' });
    expect(profile.powerZones?.[0]).toEqual({ name: 'Z1', upTo: 55 });
    expect(profile.heartRateZones).toEqual([{ name: 'Easy', upTo: 138 }, { upTo: 154 }, { name: 'Hard' }]);
    expect(heartRateTop(athlete)).toBe(190);
    expect(athleteProfileSchema.parse(profile)).toEqual(profile);
  });

  it('gives no zones that the profile would refuse', () => {
    expect(toAthlete({ sportSettings: [{ types: ['Ride'], power_zones: [90, 55, 999] }] }).powerZones).toBeUndefined();
    expect(toAthlete({ sportSettings: [{ types: ['Ride'], hr_zones: 'x' }] }).heartRateZones).toBeUndefined();
  });

  it('writes the bounds with the open zone closed as intervals.icu keeps it, and a name for every zone', () => {
    expect(
      zoneSettings({ powerZones: [{ name: 'Easy', upTo: 60 }, {}], heartRateZones: [{ upTo: 140 }, { name: 'High' }] }, 190),
    ).toEqual({
      power_zones: [60, 999],
      power_zone_names: ['Easy', 'Z2'],
      hr_zones: [140, 190],
      hr_zone_names: ['Z1', 'High'],
    });
    expect(zoneSettings({}, 190)).toEqual({});
  });
});

describe('toLibrary', () => {
  const workout = (fields: Record<string, unknown>) => ({
    id: 7,
    type: 'Ride',
    name: 'Sweet Spot',
    folder_id: 3,
    ...fields,
  });

  it('keeps the cycling workouts with their folder, ordered by folder and name', () => {
    const library = toLibrary(
      [
        workout({ id: 9, name: 'Z2', folder_id: 4 }),
        workout({ id: 8, type: 'Run', name: 'Easy Run' }),
        workout({
          moving_time: 3600,
          icu_training_load: 70,
          description: 'Seated',
          workout_doc: { steps: [{ duration: 600, power: { units: '%ftp', value: 90 } }] },
        }),
        workout({ id: 10, name: 'Loose', folder_id: null }),
      ],
      [
        { id: 3, name: 'Base', type: 'FOLDER' },
        { id: 4, name: 'Base', type: 'PLAN' },
      ],
    );
    expect(library.map((w) => [w.folder, w.name])).toEqual([
      [undefined, 'Loose'],
      ['Base', 'Sweet Spot'],
      ['Base', 'Z2'],
    ]);
    expect(library[1]).toEqual({
      id: '7',
      name: 'Sweet Spot',
      folder: 'Base',
      sport: 'ride',
      description: 'Seated',
      durationSeconds: 3600,
      trainingLoad: 70,
      steps: [
        {
          kind: 'interval',
          id: '1',
          duration: { kind: 'time', seconds: 600 },
          effort: { kind: 'target', primary: { unit: 'percent-ftp', start: { low: 90, high: 90 } } },
        },
      ],
    });
    for (const entry of library) {
      expect(libraryWorkoutSchema.parse(entry)).toEqual(entry);
    }
  });

  it('is empty for an answer that is no list', () => {
    expect(toLibrary(null, null)).toEqual([]);
  });
});

describe('libraryDocs', () => {
  it('keeps the workout document of each library workout as it is, by its id', () => {
    const doc = { steps: [{ duration: 900, power: { units: 'power_zone', value: 2 } }] };
    expect(libraryDocs([{ id: 7, workout_doc: doc }, { id: 8 }, 'x'])).toEqual({ '7': doc });
    expect(libraryDocs(null)).toEqual({});
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

describe('toActivities', () => {
  it('takes the cycling rides that were done, with the session id of an upload, oldest first', () => {
    const rides = toActivities([
      { id: 'i2', type: 'VirtualRide', name: 'Evening', start_date_local: '2026-11-04T18:00:00', start_date: '2026-11-04T17:00:00Z', moving_time: 3600, icu_training_load: 55, external_id: 'session-1' },
      { id: 'i1', type: 'Ride', start_date_local: '2026-11-02T08:00:00' },
      { id: 'i3', type: 'Run', name: 'Jog', start_date_local: '2026-11-03T08:00:00' },
      { type: 'Ride', start_date_local: '2026-11-03T08:00:00' },
    ]);
    expect(rides.map((ride) => ride.id)).toEqual(['i1', 'i2']);
    expect(rides[1]).toEqual({
      id: 'i2',
      date: '2026-11-04',
      startedAt: Date.parse('2026-11-04T17:00:00Z'),
      name: 'Evening',
      sport: 'virtual-ride',
      durationSeconds: 3600,
      trainingLoad: 55,
      externalId: 'session-1',
    });
    expect(rides.every((ride) => completedWorkoutSchema.safeParse(ride).success)).toBe(true);
  });
});
