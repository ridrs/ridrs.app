// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';
import type { Workout, WorkoutInterval, WorkoutStep } from '@ridrs/contracts';
import { decodeFit } from '@ridrs/fit';
import { describe, expect, it } from 'vitest';
import type { WorkoutImporter } from '../../codec.ts';
import { importFit } from '../fit/index.ts';
import { importErg, importIntervalsText, importMrc, importTcx, importZwo } from '../text/index.ts';
import { exportErg, exportFit, exportMrc, exportTcx, exportZwo } from './index.ts';
import type { WorkoutExport } from './shared.ts';

/**
 * The exporters' proof (structured-workouts.md, section 4.3): every vector of every format is
 * imported, exported to the format it came from and imported again, which gives the same workout;
 * canonical sources come back as the same text; FIT workouts are read by the official SDK; and
 * the conversions are the ones of section 9, each with its warning.
 */

const VECTORS = resolve(import.meta.dirname, '../../../test-vectors');
const bytesOf = (format: string, file: string) =>
  new Uint8Array(readFileSync(join(VECTORS, format, file)));
const vectorsOf = (format: string, extension: string) =>
  readdirSync(join(VECTORS, format))
    .filter((f) => f.endsWith(extension))
    .sort();

const FORMATS = {
  zwo: { extension: '.zwo', importer: importZwo as WorkoutImporter, exporter: exportZwo },
  erg: { extension: '.erg', importer: importErg as WorkoutImporter, exporter: exportErg },
  mrc: { extension: '.mrc', importer: importMrc as WorkoutImporter, exporter: exportMrc },
  tcx: { extension: '.tcx', importer: importTcx as WorkoutImporter, exporter: exportTcx },
} as const;

/** A workout without what an export of one file of several cannot keep: its id. */
const comparable = (workout: Workout): unknown => {
  const { id: _id, ...rest } = workout;
  const copy = JSON.parse(JSON.stringify(rest));
  if (copy.extensions?.tcx) copy.extensions.tcx.workoutIndex = undefined;
  return JSON.parse(JSON.stringify(copy));
};

function ok<T>(result: WorkoutExport<T>): { data: T; codes: string[] } {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.diagnostics)}`);
  return { data: result.data, codes: result.diagnostics.map((d) => d.code) };
}

const imported = (text: string, fileName = 'w.txt'): Workout => {
  const result = importIntervalsText(text, { id: 'w', fileName });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.workouts[0] as Workout;
};

describe.each(Object.entries(FORMATS))(
  'round trips: %s',
  (format, { extension, importer, exporter }) => {
    it.each(vectorsOf(format, extension))(
      '%s: import, export, import gives the same workout',
      (file) => {
        const first = importer(bytesOf(format, file), { fileName: file });
        if (!first.ok) return;
        for (const workout of first.workouts) {
          const text = ok(exporter(workout, { ftp: 250 })).data as string;
          const again = importer(text, { fileName: file });
          expect(again.ok, JSON.stringify(again.ok ? [] : again.diagnostics)).toBe(true);
          if (again.ok)
            expect(comparable(again.workouts[0] as Workout)).toEqual(comparable(workout));
        }
      },
    );
  },
);

describe('round trips: fit', () => {
  it.each(vectorsOf('fit', '.fit'))('%s: import, export, import gives the same workout', (file) => {
    const first = importFit(bytesOf('fit', file), { fileName: file });
    if (!first.ok) return;
    const workout = first.workouts[0] as Workout;
    const bytes = ok(exportFit(workout)).data;
    const again = importFit(bytes, { fileName: file });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.workouts[0]).toEqual(workout);
  });
});

describe('canonical sources come back as the same text', () => {
  it.each([
    ['zwo', 'sweet-spot-3x12.zwo'],
    ['erg', 'threshold-2x10.erg'],
    ['erg', 'percent-column.erg'],
    ['mrc', 'over-unders.mrc'],
    ['mrc', 'steps-ramp-test.mrc'],
  ] as const)('%s/%s', (format, file) => {
    const { importer, exporter } = FORMATS[format];
    const source = readFileSync(join(VECTORS, format, file), 'utf8');
    const result = importer(source, { fileName: file });
    if (!result.ok) throw new Error('refused');
    expect(ok(exporter(result.workouts[0] as Workout, {})).data).toBe(`${source.trimEnd()}\n`);
  });
});

describe('cross checks', () => {
  it('ZWO to the canonical format and back is the same ZWO', () => {
    const file = 'distance-and-unknown-parts.zwo';
    const first = importZwo(bytesOf('zwo', file), { fileName: file });
    if (!first.ok) throw new Error('refused');
    const text = ok(exportZwo(first.workouts[0] as Workout)).data;
    expect(text).toContain('<durationType>distance</durationType>');
    expect(text).toContain(
      '<IntervalsT Repeat="2" OnDuration="500" OffDuration="500" OnPower="0.95" OffPower="0.5" Flat="1">',
    );
    expect(text).toContain('<vendorHint source="test">kept as it is</vendorHint>');
    expect(text).toContain('<footer>made by hand</footer>');
    const again = importZwo(text, { fileName: file });
    if (!again.ok) throw new Error('refused');
    expect(again.workouts[0]).toEqual(first.workouts[0]);
  });

  it('FIT to the canonical format and back is the same FIT workout', () => {
    for (const file of ['repeat-cadence.fit', 'targets.fit', 'durations.fit', 'repeats.fit']) {
      const first = importFit(bytesOf('fit', file), { fileName: file });
      if (!first.ok) throw new Error('refused');
      const once = ok(exportFit(first.workouts[0] as Workout)).data;
      const second = importFit(once, { fileName: file });
      if (!second.ok) throw new Error('refused');
      expect(ok(exportFit(second.workouts[0] as Workout)).data).toEqual(once);
    }
  });
});

describe('FIT workouts are read by the official SDK', () => {
  const sdk = (bytes: Uint8Array) => {
    const stream = Stream.fromByteArray([...bytes]);
    expect(Decoder.isFIT(stream)).toBe(true);
    const decoder = new Decoder(stream);
    expect(decoder.checkIntegrity()).toBe(true);
    return decoder.read();
  };

  it.each(vectorsOf('fit', '.fit'))(
    '%s: the SDK decodes the export without errors, with the same steps',
    (file) => {
      const first = importFit(bytesOf('fit', file), { fileName: file });
      if (!first.ok) return;
      const bytes = ok(exportFit(first.workouts[0] as Workout)).data;
      const { messages, errors } = sdk(bytes);
      expect(errors).toEqual([]);
      expect(messages.fileIdMesgs?.[0]?.type).toBe('workout');
      const ours = decodeFit(bytes);
      if (!ours.ok) throw new Error('not decodable');
      const steps = ours.messages.filter((m) => m.num === 27);
      expect(messages.workoutStepMesgs).toHaveLength(steps.length);
      expect(messages.workoutMesgs?.[0]?.wktName).toBe((first.workouts[0] as Workout).name);
      expect(messages.workoutMesgs?.[0]?.numValidSteps).toBe(steps.length);
      expect(messages.workoutStepMesgs?.map((s) => s.durationType)).toEqual(
        ours.messages
          .filter((m) => m.num === 27)
          .map((m) => sdkDuration(m.fields[1]?.value as number)),
      );
    },
  );

  it('a ZWO ramp becomes small steps, a lap-button step stays open', () => {
    const workout = imported('- 10m ramp 50-75%\n- press lap 60%');
    const result = exportFit(workout);
    const { messages, errors } = sdk(ok(result).data);
    expect(errors).toEqual([]);
    expect(messages.workoutStepMesgs).toHaveLength(21);
    expect(messages.workoutStepMesgs?.at(-1)?.durationType).toBe('open');
    expect(ok(result).codes).toContain('ramp-stepped');
  });
});

/** The SDK's name for a duration type number. */
function sdkDuration(type: number): string {
  const names: Record<number, string> = {
    0: 'time',
    1: 'distance',
    2: 'hrLessThan',
    3: 'hrGreaterThan',
    4: 'calories',
    5: 'open',
    6: 'repeatUntilStepsCmplt',
    7: 'repeatUntilTime',
    8: 'repeatUntilDistance',
    9: 'repeatUntilCalories',
    10: 'repeatUntilHrLessThan',
    11: 'repeatUntilHrGreaterThan',
    12: 'repeatUntilPowerLessThan',
    13: 'repeatUntilPowerGreaterThan',
    14: 'powerLessThan',
    15: 'powerGreaterThan',
    16: 'trainingPeaksTss',
    17: 'repeatUntilPowerLastLapLessThan',
    18: 'repeatUntilMaxPowerLastLapLessThan',
    19: 'power3sLessThan',
    20: 'power10sLessThan',
    21: 'power30sLessThan',
    22: 'power3sGreaterThan',
    23: 'power10sGreaterThan',
    24: 'power30sGreaterThan',
    25: 'powerLapLessThan',
    26: 'powerLapGreaterThan',
    27: 'repeatUntilTrainingPeaksTss',
    28: 'repetitionTime',
    29: 'reps',
    31: 'timeOnly',
  };
  return names[type] ?? String(type);
}

const codes = (result: WorkoutExport<unknown>) => result.diagnostics.map((d) => d.code);

describe('converting only where the format cannot hold a unit', () => {
  const watts = imported('- 10m 200w\n- 5m 250w');
  const percent = imported('- 10m 80%\n- 5m 100%');

  it('watts to ZWO become % FTP with the FTP, warned; % stays % without a warning', () => {
    const result = exportZwo(watts, { ftp: 250 });
    expect(ok(result).data).toContain('Power="0.8"');
    expect(ok(result).data).toContain('Power="1"');
    expect(codes(result)).toContain('watts-to-percent');
    expect(codes(exportZwo(percent, { ftp: 250 }))).not.toContain('watts-to-percent');
  });

  it('watts to MRC become % FTP, % to ERG become watts, with warnings', () => {
    expect(ok(exportMrc(watts, { ftp: 200 })).data).toContain('0.00\t100\n10.00\t100\n10.00\t125');
    expect(codes(exportMrc(watts, { ftp: 200 }))).toContain('watts-to-percent');
    const erg = exportErg(percent, { ftp: 250 });
    expect(ok(erg).data).toContain('0.00\t200\n10.00\t200\n10.00\t250\n15.00\t250');
    expect(codes(erg)).toContain('percent-to-watts');
  });

  it('% to TCX become watts, watts stay watts', () => {
    expect(ok(exportTcx(percent, { ftp: 250 })).data).toContain('<Value>200</Value>');
    expect(codes(exportTcx(percent, { ftp: 250 }))).toContain('percent-to-watts');
    expect(codes(exportTcx(watts, { ftp: 250 }))).not.toContain('percent-to-watts');
  });

  it('an export that needs an FTP and has none is refused with its reason', () => {
    for (const result of [
      exportZwo(watts),
      exportMrc(watts),
      exportErg(percent),
      exportTcx(percent),
    ]) {
      expect(result.ok).toBe(false);
      const error = result.diagnostics.find((d) => d.severity === 'error');
      expect(error?.code).toBe('ftp-required');
      expect(error?.message).toMatch(/needs an FTP/);
    }
    expect(exportZwo(percent).ok).toBe(true);
    expect(exportErg(watts).ok).toBe(true);
    expect(exportTcx(watts).ok).toBe(true);
    expect(exportFit(watts).ok).toBe(true);
  });

  it('a power zone is a % FTP range for ZWO and watts for ERG', () => {
    const zone = imported('- 10m Z2');
    expect(ok(exportZwo(zone)).data).toContain('Power="0.65"');
    expect(codes(exportZwo(zone))).toContain('zone-converted');
    expect(exportErg(zone).ok).toBe(false);
    expect(ok(exportErg(zone, { ftp: 200 })).data).toContain('0.00\t130');
  });

  it('a range is written as its middle, warned', () => {
    const range = imported('- 10m 200-220w');
    expect(ok(exportErg(range)).data).toContain('0.00\t210');
    expect(codes(exportErg(range))).toContain('range-to-middle');
  });
});

describe('steps a format cannot hold', () => {
  const mixed = imported('- 10m 75%\n- 5m 140-150bpm\n- press lap 60%\n- 2km 70%');

  it('heart rate, lap-button and distance steps become time steps in ZWO, with warnings', () => {
    const result = exportZwo(mixed, { ftp: 250 });
    const text = ok(result).data;
    expect(text).toContain('<SteadyState Duration="600" Power="0.75"/>');
    // 5 min lap button estimate, 2 km at 30 km/h = 240 s
    expect(text).toContain('<FreeRide Duration="300"/>');
    expect(text).toContain('<SteadyState Duration="300" Power="0.6"/>');
    expect(text).toContain('<SteadyState Duration="240" Power="0.7"/>');
    expect(codes(result)).toEqual(
      expect.arrayContaining(['target-to-free-ride', 'duration-estimated']),
    );
  });

  it('they hold the last power in ERG and MRC', () => {
    const erg = ok(exportErg(mixed, { ftp: 200 })).data;
    expect(erg).toContain('0.00\t150\n10.00\t150\n15.00\t150\n15.00\t120');
    expect(codes(exportErg(mixed, { ftp: 200 }))).toContain('target-held');
    expect(ok(exportMrc(mixed)).data).toContain('10.00\t75\n15.00\t75');
  });

  it('repeats are written out in ERG and MRC, cadence is dropped', () => {
    const repeat = imported('3x\n- 1m 100% 90rpm\n- 1m 50%');
    const result = exportErg(repeat, { ftp: 200 });
    expect(ok(result).data).toContain('6.00\t100');
    expect(codes(result)).toEqual(expect.arrayContaining(['repeats-unrolled', 'cadence-dropped']));
    expect(codes(exportMrc(repeat))).toContain('repeats-unrolled');
  });

  it('ZWO keeps a repeat of an on and an off step as IntervalsT with cadence, and writes other repeats out', () => {
    const two = ok(exportZwo(imported('5x\n- 1m 120% 100rpm\n- 1m 50%'))).data;
    expect(two).toContain(
      '<IntervalsT Repeat="5" OnDuration="60" OffDuration="60" OnPower="1.2" OffPower="0.5" Cadence="100"/>',
    );
    const three = exportZwo(imported('2x\n- 1m 100%\n- 1m 50%\n- 1m 60%'));
    expect(ok(three).data).not.toContain('IntervalsT');
    expect((ok(three).data.match(/<SteadyState/g) ?? []).length).toBe(6);
    expect(codes(three)).toContain('repeat-unrolled');
  });

  it('TCX and FIT write a ramp as small steps', () => {
    const ramp = imported('- 10m ramp 50-75%');
    expect(codes(exportTcx(ramp, { ftp: 200 }))).toContain('ramp-stepped');
    expect(codes(exportFit(ramp))).toContain('ramp-stepped');
  });

  it('FIT keeps watts, zones and heart rate bounds without a warning', () => {
    const rich = imported('- 10m 200w\n- 5m Z3\n- 10m 140-150bpm');
    expect(exportFit(rich).diagnostics).toEqual([]);
  });

  it('a step edited after the import drops what the extension described', () => {
    const file = 'sweet-spot-3x12.zwo';
    const first = importZwo(bytesOf('zwo', file), { fileName: file });
    if (!first.ok) throw new Error('refused');
    const workout = first.workouts[0] as Workout;
    const first2 = workout.steps[1] as WorkoutStep;
    if (first2.kind !== 'interval') throw new Error('not an interval');
    // The warm-up (a Warmup element) is no ramp any more: it is not written as <Warmup>.
    const edited: Workout = {
      ...workout,
      steps: [
        {
          ...(workout.steps[0] as WorkoutInterval),
          effort: {
            kind: 'target',
            primary: { unit: 'percent-ftp', start: { low: 60, high: 60 } },
          },
        },
        ...workout.steps.slice(1),
      ],
    };
    const text = ok(exportZwo(edited)).data;
    expect(text).toContain('<SteadyState Duration="600" Power="0.6">');
    expect(text).not.toContain('<Warmup');
  });
});
