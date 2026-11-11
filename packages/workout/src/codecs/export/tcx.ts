// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workout, WorkoutInterval, WorkoutRepeat, WorkoutStep } from '@ridrs/contracts';
import { record } from './common.ts';
import {
  extensionOf,
  finishExport,
  Notes,
  PowerConverter,
  placeOf,
  primaryOf,
  secondaryOf,
  secondsOf,
  stepRamps,
  type WorkoutExport,
  type WorkoutExportOptions,
} from './shared.ts';
import { el, fromJson, interleave, placedNodes, renderXml, textEl, type XNode } from './xmlout.ts';

/**
 * Garmin TCX workouts, the elements `importTcx` reads (TrainingCenterDatabase v2). TCX holds
 * power in watts or as a zone: % FTP is converted to watts with the FTP, unless the file said it
 * held % (`extensions.tcx`). It has no ramps (a ramp is written as small steps), one target per
 * step, four intensities, and heart rate bounds as the only `until`. An export of a TCX workout
 * restores `extensions.tcx` as far as the steps still match it.
 */

type Pairs = [string, string][];
const attrsOf = (value: unknown): Pairs =>
  Object.entries(record(value) ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);

const XSI = 'xsi:type';
const plain = (value: number): string => String(Math.round(value * 1000) / 1000);
const percentLike = (type: unknown): boolean => typeof type === 'string' && /percent/i.test(type);

const INTENSITY: Record<string, string> = {
  active: 'Active',
  rest: 'Resting',
  'warm-up': 'Warmup',
  'cool-down': 'Cooldown',
  interval: 'Active',
  recovery: 'Resting',
  other: 'Active',
};

interface Context {
  readonly notes: Notes;
  readonly power: PowerConverter;
  next: number;
}

/** `<Low xsi:type="PowerInWatts_t"><Value>250</Value></Low>` */
const measure = (name: string, type: string, value: number): XNode =>
  el(name, [[XSI, type]], [el('Value', [], [{ text: plain(value) }])]);

function durationNode(step: WorkoutInterval, context: Context): { node: XNode; kind: string } {
  const own = record(extensionOf(step, 'tcx')?.duration);
  const { duration } = step;
  let type: string;
  let known: XNode[];
  if (
    duration.kind === 'time' ||
    (duration.kind === 'until' && !['bpm', 'percent-max-hr'].includes(duration.unit))
  ) {
    const seconds = secondsOf(step, context.notes, 'tcx');
    type = 'Time_t';
    known = [textEl('Seconds', plain(seconds))];
  } else if (duration.kind === 'distance') {
    type = 'Distance_t';
    known = [textEl('Meters', plain(duration.meters))];
  } else if (duration.kind === 'energy') {
    type = 'CaloriesBurned_t';
    known = [textEl('Calories', plain(duration.kilocalories))];
  } else if (duration.kind === 'open') {
    type =
      typeof own?.type === 'string' && ['LapButton_t', 'UserInput_t'].includes(own.type)
        ? own.type
        : 'UserInput_t';
    known = [];
  } else {
    const percent = duration.unit === 'percent-max-hr';
    type = duration.comparison === 'above' ? 'HeartRateAbove_t' : 'HeartRateBelow_t';
    const stated =
      typeof own?.heartRateType === 'string' && percentLike(own.heartRateType) === percent
        ? own.heartRateType
        : undefined;
    known = [
      measure(
        'HeartRate',
        stated ?? (percent ? 'HeartRateInPercentOfMax_t' : 'HeartRateInBeatsPerMinute_t'),
        duration.value,
      ),
    ];
  }
  const restores = own?.type === type;
  const extension = restores ? own : undefined;
  return {
    kind: type,
    node: el(
      'Duration',
      [[XSI, type], ...attrsOf(extension?.attributes)],
      interleave(known, placedNodes(extension?.children)),
    ),
  };
}

/** A target with its unit expressed as TCX holds it, or the reason it cannot be. */
function targetNode(step: WorkoutInterval, context: Context): XNode {
  const { notes, power } = context;
  const at = placeOf(step);
  const own = record(extensionOf(step, 'tcx')?.target);
  const primary = primaryOf(step);
  const cadence = [...(primary ? [primary] : []), ...secondaryOf(step)].find(
    (t) => t.unit === 'rpm',
  );
  const free = (): XNode => {
    if (step.effort.kind === 'free' && own?.type !== undefined && own.raw !== undefined) {
      const raw = fromJson(own.raw);
      if (raw) return raw;
    }
    return el('Target', [[XSI, 'None_t']]);
  };
  const finish = (type: string, known: XNode[]): XNode => {
    const restores = own?.type === type;
    return el(
      'Target',
      [[XSI, type], ...(restores ? attrsOf(own?.attributes) : [])],
      interleave(known, restores ? placedNodes(own?.children) : []),
    );
  };
  const zone = (name: string, type: string, known: XNode[], deepType: string): XNode => {
    const stated = record(own?.zone);
    const restores = own?.type === deepType && stated?.type === type;
    return el(
      name,
      [[XSI, type], ...(restores ? attrsOf(stated?.attributes) : [])],
      interleave(known, restores ? placedNodes(stated?.children) : []),
    );
  };
  const custom = (
    unit: 'power' | 'hr',
    zoneName: string,
    deepType: string,
    lowType: string,
    low: number,
    high: number,
  ): XNode => {
    const stated = record(own?.zone);
    const useStated = own?.type === deepType && stated?.type?.toString().startsWith('Custom');
    const lt =
      useStated && percentLike(stated?.lowType) === percentLike(lowType)
        ? String(stated?.lowType)
        : lowType;
    const ht =
      useStated && percentLike(stated?.highType) === percentLike(lowType)
        ? String(stated?.highType)
        : lt;
    return finish(deepType, [
      zone(
        zoneName,
        unit === 'power' ? 'CustomPowerZone_t' : 'CustomHeartRateZone_t',
        [measure('Low', lt, low), measure('High', ht, high)],
        deepType,
      ),
    ]);
  };

  if (step.effort.kind === 'max-effort') {
    notes.warn(
      'max-effort-open',
      `${at}: TCX has no all-out step; the step has no target.`,
      step.id,
    );
    return free();
  }
  if (!primary || primary.unit === 'rpm') {
    if (cadence) {
      return finish('Cadence_t', [
        textEl('Low', plain(cadence.start.low)),
        textEl('High', plain(cadence.start.high)),
      ]);
    }
    return free();
  }
  if (cadence) {
    notes.warn(
      'secondary-dropped',
      `${at}: TCX holds one target per step; the cadence is not written.`,
      step.id,
    );
  }
  if (secondaryOf(step).some((t) => t.unit !== 'rpm')) {
    notes.warn(
      'secondary-dropped',
      `${at}: TCX holds one target per step; the second one is not written.`,
      step.id,
    );
  }
  const { start } = primary;
  switch (primary.unit) {
    case 'power-zone': {
      if (start.low !== start.high) {
        notes.warn(
          'zone-range',
          `${at}: TCX holds one power zone; the lowest is written.`,
          step.id,
        );
      }
      return finish('Power_t', [
        zone('PowerZone', 'PredefinedPowerZone_t', [textEl('Number', plain(start.low))], 'Power_t'),
      ]);
    }
    case 'hr-zone': {
      if (start.low !== start.high) {
        notes.warn(
          'zone-range',
          `${at}: TCX holds one heart rate zone; the lowest is written.`,
          step.id,
        );
      }
      return finish('HeartRate_t', [
        zone(
          'HeartRateZone',
          'PredefinedHeartRateZone_t',
          [textEl('Number', plain(start.low))],
          'HeartRate_t',
        ),
      ]);
    }
    case 'watts':
      return custom('power', 'PowerZone', 'Power_t', 'PowerInWatts_t', start.low, start.high);
    case 'percent-ftp': {
      const stated = record(own?.zone);
      if (own?.type === 'Power_t' && percentLike(stated?.lowType)) {
        return custom(
          'power',
          'PowerZone',
          'Power_t',
          String(stated?.lowType),
          start.low,
          start.high,
        );
      }
      const watts = power.watts(start, 'percent-ftp', at) ?? { low: 0, high: 0 };
      return custom('power', 'PowerZone', 'Power_t', 'PowerInWatts_t', watts.low, watts.high);
    }
    case 'bpm':
      return custom(
        'hr',
        'HeartRateZone',
        'HeartRate_t',
        'HeartRateInBeatsPerMinute_t',
        start.low,
        start.high,
      );
    case 'percent-max-hr':
      return custom(
        'hr',
        'HeartRateZone',
        'HeartRate_t',
        'HeartRateInPercentOfMax_t',
        start.low,
        start.high,
      );
    case 'meters-per-second':
      return finish('Speed_t', [
        zone(
          'SpeedZone',
          'CustomSpeedZone_t',
          [
            textEl('LowInMetersPerSecond', plain(start.low)),
            textEl('HighInMetersPerSecond', plain(start.high)),
          ],
          'Speed_t',
        ),
      ]);
    default:
      notes.warn(
        'target-dropped',
        `${at}: a target in ${primary.unit} cannot be written in TCX; the step has no target.`,
        step.id,
      );
      return free();
  }
}

function stepNode(step: WorkoutInterval, element: 'Step' | 'Child', context: Context): XNode {
  const extension = extensionOf(step, 'tcx');
  const at = placeOf(step);
  const id = typeof extension?.stepId === 'string' ? extension.stepId : String(context.next);
  context.next += 1;
  const duration = durationNode(step, context);
  if (step.intensity && ['interval', 'recovery', 'other'].includes(step.intensity)) {
    context.notes.warn(
      'intensity-approximated',
      `${at}: TCX has four intensities; "${step.intensity}" is written as ${INTENSITY[step.intensity]}.`,
      step.id,
    );
  }
  const intensity = step.intensity
    ? INTENSITY[step.intensity]
    : typeof extension?.intensity === 'string'
      ? extension.intensity
      : 'Active';
  const known: XNode[] = [
    textEl('StepId', id),
    ...(step.name ? [textEl('Name', step.name)] : []),
    duration.node,
    textEl('Intensity', intensity as string),
    targetNode(step, context),
    ...(step.notes ? [textEl('Notes', step.notes)] : []),
  ];
  if (step.cues?.length) {
    context.notes.warn('cues-dropped', 'TCX has no texts during a step; they are not written.');
  }
  const type = extension?.type === undefined ? 'Step_t' : String(extension.type);
  return el(
    element,
    [[XSI, type === 'Repeat_t' ? 'Step_t' : type], ...attrsOf(extension?.attributes)],
    interleave(known, placedNodes(extension?.children)),
  );
}

function stepNodes(
  steps: readonly WorkoutStep[],
  element: 'Step' | 'Child',
  context: Context,
): XNode[] {
  const out: XNode[] = [];
  for (const step of steps) {
    if (step.kind === 'interval') {
      out.push(stepNode(step, element, context));
      continue;
    }
    if (step.until.kind !== 'count') {
      context.notes.warn(
        'repeat-until-once',
        `A repeat that ends by ${step.until.kind} is written once; TCX repeats by count only.`,
        step.id,
      );
      out.push(...stepNodes(step.steps, element, context));
      continue;
    }
    out.push(repeatNode(step, element, context));
  }
  return out;
}

function repeatNode(step: WorkoutRepeat, element: 'Step' | 'Child', context: Context): XNode {
  const extension = extensionOf(step, 'tcx');
  const id = typeof extension?.stepId === 'string' ? extension.stepId : String(context.next);
  context.next += 1;
  const reps = (step.until as { reps: number }).reps;
  const known: XNode[] = [
    textEl('StepId', id),
    ...(typeof extension?.name === 'string' ? [textEl('Name', extension.name)] : []),
    textEl('Repetitions', String(reps)),
    ...stepNodes(step.steps, 'Child', context),
  ];
  return el(
    element,
    [[XSI, 'Repeat_t'], ...attrsOf(extension?.attributes)],
    interleave(known, placedNodes(extension?.children)),
  );
}

const NAMESPACES: Pairs = [
  ['xmlns', 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2'],
  ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
  [
    'xsi:schemaLocation',
    'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd',
  ],
];

export function exportTcx(
  workout: Workout,
  options: WorkoutExportOptions = {},
): WorkoutExport<string> {
  const notes = new Notes();
  const context: Context = { notes, power: new PowerConverter(options, notes), next: 1 };
  const steps = stepNodes(stepRamps(workout.steps, notes, 'tcx'), 'Step', context);
  if (workout.referenceFtp || workout.focus || workout.declared || workout.subSport) {
    notes.warn(
      'metadata-dropped',
      'TCX has no place for the reference FTP, focus, declared values and sub sport.',
    );
  }

  return finishExport('tcx', notes, () => {
    const extension = extensionOf(workout, 'tcx');
    const document = record(extension?.document);
    const workoutNode = el(
      'Workout',
      [['Sport', 'Biking'], ...attrsOf(extension?.attributes)],
      interleave(
        [
          textEl('Name', workout.name),
          ...steps,
          ...(workout.description ? [textEl('Notes', workout.description)] : []),
        ],
        placedNodes(extension?.children),
      ),
    );
    const workouts = record(document?.workouts);
    const workoutsNode = el(
      'Workouts',
      attrsOf(workouts?.attributes),
      interleave([workoutNode], placedNodes(workouts?.children)),
    );
    const root = el(
      'TrainingCenterDatabase',
      document?.attributes ? attrsOf(document.attributes) : NAMESPACES,
      interleave([workoutsNode], placedNodes(document?.children)),
    );
    return renderXml(root, { declaration: '<?xml version="1.0" encoding="UTF-8"?>', indent: '  ' });
  });
}
