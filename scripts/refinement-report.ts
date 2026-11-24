// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the video routes of a library need in-between frames (plan `video-zwischenframes.md`,
// phase 1): per route the share of the video that is refined, by factor, the frames to compute,
// an estimate of the time Apple's frame rate conversion takes for them (55 ms per frame pair,
// measured at 1080p in `experiments/rife-onnx-spike`, round 2), and the fewest frames per second
// a rider at 100 W and at 150 W sees before and after. Reads no video, only the control files
// and tracks.
//
//   pnpm report:refinement [folder …] [--json]
//
// Every `*.xml` below a folder that is an Incyclist control file with a track beside it is a
// route. The folder defaults to the shipped Van Gestel catalog (`content/vangestel`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { type Control, parseControl, planRefinement, type RefinementPlan } from '@ridrs/ride';
import { Window } from 'happy-dom';
import { parseGpx } from '../plugins/ui-world-video/client/library.ts';
import { plausibleTrack } from '../plugins/ui-world-video/client/plausible-track.ts';

/** s Apple's frame rate conversion takes per frame pair at 1080p, whatever the factor (round 2). */
const SECONDS_PER_PAIR = 0.055;
const POWERS = [100, 150] as const;

const args = process.argv.slice(2);
const json = args.includes('--json');
const folders = args.filter((arg) => !arg.startsWith('--'));
const roots = (folders.length > 0 ? folders : [join(import.meta.dirname, '../content/vangestel')]).map((f) =>
  resolve(f),
);

function controlFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) return controlFiles(path);
    return entry.name.toLowerCase().endsWith('.xml') ? [path] : [];
  });
}

interface Row {
  readonly route: string;
  readonly frameRate: number;
  readonly minutes: number;
  readonly cuts: number;
  readonly plans: Record<number, RefinementPlan>;
}

async function readRoute(path: string, root: string): Promise<Row | undefined> {
  let control: Control;
  try {
    control = parseControl(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const gpx = join(dirname(path), control.gpx);
  if (!control.gpx || !existsSync(gpx)) return undefined;
  // A window per route, closed after it: happy-dom keeps a parsed track's document until then.
  const window = new Window();
  globalThis.DOMParser = window.DOMParser as unknown as typeof DOMParser;
  const points = parseGpx(readFileSync(gpx, 'utf8'));
  await window.happyDOM.close();
  const { track, repairs } = plausibleTrack(points);
  const offset = (control.startFrame - 1) / control.framerate;
  // A jump of the track is a cut of the video or of the GPS: no stretch is refined across it.
  const cuts = repairs.filter((repair) => repair.kind === 'jump').map((repair) => offset + repair.time);
  const plans = Object.fromEntries(
    POWERS.map((power) => [power, planRefinement({ track, frameRate: control.framerate, offset, cuts, power })]),
  );
  return {
    route: relative(root, dirname(path)) || control.title || path,
    frameRate: control.framerate,
    minutes: (track.points.at(-1)?.time ?? 0) / 60,
    cuts: cuts.length,
    plans,
  };
}

const rows: Row[] = [];
for (const root of roots) {
  for (const path of controlFiles(root)) {
    const row = await readRoute(path, root);
    if (row) rows.push(row);
  }
}

/** Minutes of the video refined with `factor`. */
const minutesWith = (plan: RefinementPlan, factor: number) =>
  plan.stretches.filter((s) => s.factor === factor).reduce((sum, s) => sum + s.to - s.from, 0) / 60;

if (json) {
  console.log(
    JSON.stringify(
      rows.map(({ plans, ...row }) => ({
        ...row,
        ...Object.fromEntries(
          POWERS.map((power) => [
            `at${power}W`,
            { stretches: plans[power]?.stretches, summary: plans[power]?.summary },
          ]),
        ),
      })),
      null,
      2,
    ),
  );
} else {
  const plan100 = (row: Row) => row.plans[100] as RefinementPlan;
  const header = [
    'route',
    'fps',
    'min',
    'cuts',
    'refined %',
    'min ×2/×4/×8',
    'in-between',
    'VT min',
    '100 W fps before→after',
    '150 W before',
  ];
  const lines = rows.map((row) => {
    const plan = plan100(row);
    const { summary } = plan;
    return [
      row.route,
      String(row.frameRate),
      row.minutes.toFixed(1),
      String(row.cuts),
      (summary.refinedShare * 100).toFixed(0),
      [2, 4, 8].map((factor) => minutesWith(plan, factor).toFixed(1)).join('/'),
      String(summary.inBetweenFrames),
      ((summary.framePairs * SECONDS_PER_PAIR) / 60).toFixed(0),
      `${summary.lowestSeenBefore.toFixed(1)}→${summary.lowestSeenAfter.toFixed(1)}`,
      (row.plans[150] as RefinementPlan).summary.lowestSeenBefore.toFixed(1),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((line) => (line[i] ?? '').length)));
  const format = (cells: readonly string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join('  ');
  console.log(format(header));
  for (const line of lines) console.log(format(line));
  const total = rows.reduce((sum, row) => sum + plan100(row).summary.framePairs, 0);
  console.log(
    `\n${rows.length} routes; at 100 W: ${rows.reduce((s, r) => s + plan100(r).summary.inBetweenFrames, 0)} in-between frames, ` +
      `about ${((total * SECONDS_PER_PAIR) / 3600).toFixed(1)} h of frame rate conversion at 1080p.`,
  );
}
