// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CandidateEvent, WorkoutInterval, WorkoutStructure } from '@tabata-sync/contracts';
import { clamp01 } from '../dsp/signal.ts';
import type { SpokenCountdown } from './countdowns.ts';
import { cueStart, type EvidenceCurves } from './evidence.ts';

export const INTERVAL_MODEL_VERSION = '2.0.0';

/**
 * Only regular workouts are supported: one work length, one recovery length, repeated for a
 * number of rounds between a warm-up and a cooldown. The weights rank the evidence: the beat at
 * a spoken countdown's zero, then tonal cues (whistles, beeps), then volume steps.
 */
export interface GridOptions {
  readonly countdownWeight: number;
  readonly cueWeight: number;
  readonly volumeWeight: number;
  readonly minIntervalSec: number;
  readonly maxCycleSec: number;
  readonly minRounds: number;
  /** How far (in standard deviations of shifted grids) the fit must beat chance. */
  readonly minSignificance: number;
}

export const DEFAULT_GRID_OPTIONS: GridOptions = {
  countdownWeight: 3,
  cueWeight: 1.5,
  volumeWeight: 1,
  minIntervalSec: 3,
  maxCycleSec: 300,
  // Interval workouts have at least three rounds; two regular ones can happen by chance.
  minRounds: 3,
  minSignificance: 4,
};

export interface GridInput {
  readonly durationSec: number;
  readonly curves: EvidenceCurves;
  readonly countdowns: readonly SpokenCountdown[];
}

export interface GridFit {
  readonly startSec: number;
  readonly cycleSec: number;
  readonly workSec: number;
  readonly rounds: number;
  /** Fit score in standard deviations above grids at shifted phases. */
  readonly significance: number;
}

export interface GridResult {
  readonly structure: WorkoutStructure;
  readonly candidates: CandidateEvent[];
  readonly fit: GridFit | null;
}

/**
 * Whisper's word times put a countdown's zero within about half a second of the boundary, in
 * either direction; the beats around it say exactly where, and the grid says which beat.
 */
const COUNTDOWN_BEAT_SEC = 0.8;
const COUNTDOWN_SIGMA_SEC = 0.35;
/** The words of a countdown span from shortly before its first number to after its command. */
const SPOKEN_MARGIN_SEC = 0.3;
const COMMAND_SEC = 0.8;
/** Volume steps count from this many dB on, scaled so that this many dB more count as 1. */
const VOLUME_MIN_DB = 2;
const VOLUME_UNIT_DB = 6;
const VOLUME_TOLERANCE_SEC = 1.5;
/**
 * Cues count only where they clearly stand out: music has tonal moments all the time (a sung
 * note), and many weak hits would otherwise favor short cycles that collect them.
 */
const CUE_MIN = 0.4;
const CUE_UNIT = 0.6;
/** Evidence is matched to a grid boundary within this distance. */
const MATCH_SEC = 0.1;
/** Precise evidence (beats at zero, cue onsets) refines the grid within this distance. */
const REFINE_SEC = 0.4;
const CYCLE_REFINE_SEC = 0.1;
/** Observations agree with a grid within about this much. */
const AGREEMENT_SEC = 0.05;
const INLIER_SEC = 0.1;
const OBSERVATION_MIN = 0.5;
/** Per round, a little evidence must be found, or the workout does not extend over it. */
const ROUND_COST = 1.2;
const FOLD_BIN_SEC = 0.1;
const EVENT_MIN = 0.3;
const HYPOTHESES = 40;
const LOCAL_HYPOTHESES = 20;
const LOCAL_SEC = 0.2;
const LOCAL_STEP_SEC = 0.05;
/** Level contrast: per minute of workout, a separation of 1 counts like this much evidence. */
const CONTRAST_PER_MINUTE = 1;
const MAX_CONTRAST = 3;
const LEVEL_MARGIN_SEC = 1;
const LEVEL_FLOOR_DB = 1;
const NULL_PHASES = 64;
/**
 * Share of a grid's boundaries that need evidence of their own. A real workout marks nearly every
 * boundary somehow, even if some cues are missing.
 */
const MIN_SUPPORT = 0.6;
/** A level step this large against a boundary's direction contradicts it. */
const CONTRADICTION_DB = 3;
const CONTRADICTION_SHARE = 0.2;
/** Level steps this close to a countdown's zero may be the voice. */
const VOICE_STEP_SEC = 2;

interface Curves {
  readonly work: Float32Array;
  readonly recovery: Float32Array;
  /** Without volume: evidence whose timing is precise. */
  readonly preciseWork: Float32Array;
  readonly preciseRecovery: Float32Array;
  readonly volumeUp: Float32Array;
  readonly volumeDown: Float32Array;
  /** The precise sources one by one, weighted, and which boundaries each can mark. */
  readonly sources: ReadonlyArray<{ readonly curve: Float32Array; readonly into: 'work' | 'recovery' | 'both'; readonly cueTimed?: boolean }>;
  readonly curves: EvidenceCurves;
}

interface Hypothesis {
  cycleSec: number;
  phaseSec: number;
  workSec: number;
}

interface Evaluated extends Hypothesis {
  score: number;
  /** The score from boundary evidence alone, comparable with shifted grids. */
  evidence: number;
  firstRound: number;
  rounds: number;
}

/** The workout as a regular grid: the grid that explains the most evidence, or none. */
export function fitRegularWorkout(input: GridInput, options: GridOptions = DEFAULT_GRID_OPTIONS): GridResult {
  const { curves, durationSec } = input;
  const frameSec = curves.frameSec;
  const typed = buildCurves(input, options);
  const candidates = evidenceEvents(input, typed);

  // Matching tolerates small timing errors of the evidence and of the searched cycle.
  const tolerance = Math.round(MATCH_SEC / frameSec);
  // Volume steps say that and which way the music changes, but not exactly when: a fade or a
  // late drop moves them by a second or two. They support a boundary, the rest times it.
  const loose = Math.round(VOLUME_TOLERANCE_SEC / frameSec);
  const work = add(excess(dilate(typed.preciseWork, tolerance)), excess(dilate(typed.volumeUp, loose)));
  const recovery = add(excess(dilate(typed.preciseRecovery, tolerance)), excess(dilate(typed.volumeDown, loose)));

  const scoring: Scoring = { work, recovery, level: prefixSums(curves.level), durationSec, frameSec, options };
  const coarse = searchCycles(typed, durationSec, frameSec, options)
    .flatMap(withRelatives)
    .map((h) => evaluate(h, scoring))
    .filter((e): e is Evaluated => e !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, LOCAL_HYPOTHESES);
  // Coarse phases are a fold bin off; compare grids only after placing each one well. The work
  // length is searched in full: recovery evidence is often weaker than work evidence.
  const placed: Evaluated[] = [];
  for (const h of coarse) {
    let here: Evaluated | null = null;
    for (let dp = -LOCAL_SEC; dp <= LOCAL_SEC + 1e-9; dp += LOCAL_STEP_SEC) {
      for (let workSec = options.minIntervalSec; workSec <= h.cycleSec - options.minIntervalSec + 1e-9; workSec += LOCAL_STEP_SEC) {
        const evaluated = evaluate({ cycleSec: h.cycleSec, phaseSec: h.phaseSec + dp, workSec }, scoring);
        if (!evaluated) continue;
        // A tie between work and recovery phases goes to the longer work interval.
        if (workSec >= h.cycleSec - workSec) evaluated.score += 1e-6;
        if (!here || evaluated.score > here.score) here = evaluated;
      }
    }
    if (here) placed.push(here);
  }
  const best = placed.sort((a, b) => b.score - a.score).find((p) => p.rounds >= options.minRounds) ?? null;
  if (!best) return { structure: noWorkout(durationSec), candidates, fit: null };

  const significance = significanceOf(best, scoring);
  if (significance < options.minSignificance) return { structure: noWorkout(durationSec), candidates, fit: null };

  const refined = refine(best, typed, durationSec, frameSec);
  const fit: GridFit = { ...refined, significance };
  const structure = describe(fit, typed, curves, durationSec, options);
  if (structure.pattern.support < MIN_SUPPORT || contradictsVolume(structure, curves, input.countdowns)) {
    return { structure: noWorkout(durationSec), candidates, fit: null };
  }
  return { structure, candidates, fit };
}

/**
 * The fold cannot tell a grid from its multiples: a 15 s grid contains every boundary of a 30 s
 * one, a 60 s grid every boundary of a 120/60 workout. Extra cues inside intervals (a whoosh
 * before a countdown) can even favor the shorter one. So double and triple cycles (with every
 * choice of phases) and half and third cycles are scored too.
 */
function withRelatives(h: Hypothesis): Hypothesis[] {
  const { cycleSec: c, phaseSec: p, workSec: w } = h;
  const relatives: Hypothesis[] = [h];
  for (const m of [2, 3]) {
    // Every way to keep one of m work phases and one of m recovery phases.
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) relatives.push({ cycleSec: m * c, phaseSec: p + i * c, workSec: w + ((j - i + m) % m) * c });
    relatives.push({ cycleSec: c / m, phaseSec: p, workSec: w % (c / m) });
  }
  return relatives;
}

function buildCurves(input: GridInput, options: GridOptions): Curves {
  const { curves } = input;
  const n = curves.frames;
  const frameSec = curves.frameSec;
  const cd = { any: new Float32Array(n), work: new Float32Array(n), recovery: new Float32Array(n) };
  const radius = Math.round(COUNTDOWN_BEAT_SEC / frameSec);
  for (const countdown of input.countdowns) {
    const center = Math.round(countdown.zeroSec / frameSec);
    let strongest = 0;
    for (let f = Math.max(0, center - radius); f <= Math.min(n - 1, center + radius); f++) strongest = Math.max(strongest, curves.onset[f] as number);
    const target = countdown.into ? cd[countdown.into] : cd.any;
    for (let f = Math.max(0, center - 2 * radius); f <= Math.min(n - 1, center + 2 * radius); f++) {
      const g = Math.exp(-(((f - center) * frameSec) ** 2) / (2 * COUNTDOWN_SIGMA_SEC ** 2));
      // The beat nearest to zero, not zero itself: whisper's word times scatter, the music does not.
      const beat = strongest > 0 ? (curves.onset[f] as number) / strongest : 0;
      target[f] = Math.max(target[f] as number, g * (0.7 * beat + 0.3));
    }
  }
  const preciseWork = new Float32Array(n);
  const preciseRecovery = new Float32Array(n);
  const work = new Float32Array(n);
  const recovery = new Float32Array(n);
  // A coach's words are tonal cues of their own; a recognized countdown explains them and times
  // its boundary by the beat.
  const spoken = new Uint8Array(n);
  for (const c of input.countdowns) {
    for (let f = Math.max(0, Math.round((c.startSec - SPOKEN_MARGIN_SEC) / frameSec)); f <= Math.min(n - 1, Math.round((c.zeroSec + COMMAND_SEC) / frameSec)); f++) spoken[f] = 1;
  }
  const cues = new Float32Array(n);
  const volumeUp = new Float32Array(n);
  const volumeDown = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const cue = spoken[f] ? 0 : options.cueWeight * Math.min(2, Math.max(0, (curves.cue[f] as number) - CUE_MIN) / CUE_UNIT);
    cues[f] = cue;
    const any = options.countdownWeight * (cd.any[f] as number) + cue;
    preciseWork[f] = any + options.countdownWeight * (cd.work[f] as number);
    preciseRecovery[f] = any + options.countdownWeight * (cd.recovery[f] as number);
    const db = curves.step[f] as number;
    const step = Math.min(1.5, Math.max(0, Math.abs(db) - VOLUME_MIN_DB) / VOLUME_UNIT_DB);
    volumeUp[f] = db > 0 ? options.volumeWeight * step : 0;
    volumeDown[f] = db < 0 ? options.volumeWeight * step : 0;
    work[f] = (preciseWork[f] as number) + (volumeUp[f] as number);
    recovery[f] = (preciseRecovery[f] as number) + (volumeDown[f] as number);
  }
  const weighted = (curve: Float32Array) => curve.map((v) => options.countdownWeight * v);
  const sources = [
    { curve: weighted(cd.any), into: 'both' as const },
    { curve: weighted(cd.work), into: 'work' as const },
    { curve: weighted(cd.recovery), into: 'recovery' as const },
    { curve: cues, into: 'both' as const, cueTimed: true },
  ];
  return { work, recovery, preciseWork, preciseRecovery, volumeUp, volumeDown, sources, curves };
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((v, i) => v + (b[i] as number));
}

function dilate(curve: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(curve.length);
  for (let f = 0; f < curve.length; f++) {
    let m = 0;
    for (let g = Math.max(0, f - radius); g <= Math.min(curve.length - 1, f + radius); g++) m = Math.max(m, curve[g] as number);
    out[f] = m;
  }
  return out;
}

/** Evidence above its own average, so grids at random phases score about zero. */
function excess(curve: Float32Array): Float32Array {
  let sum = 0;
  for (const v of curve) sum += v;
  const mean = sum / Math.max(1, curve.length);
  return curve.map((v) => v - mean);
}

interface Event {
  readonly timeSec: number;
  readonly weight: number;
}

function peaks(curve: Float32Array, frameSec: number, radiusSec: number, min: number): Event[] {
  const radius = Math.round(radiusSec / frameSec);
  const out: Event[] = [];
  for (let f = 0; f < curve.length; f++) {
    const v = curve[f] as number;
    if (v < min) continue;
    let top = true;
    for (let g = Math.max(0, f - radius); g <= Math.min(curve.length - 1, f + radius) && top; g++) {
      if ((curve[g] as number) > v || ((curve[g] as number) === v && g < f)) top = false;
    }
    if (top) out.push({ timeSec: f * frameSec, weight: v });
  }
  return out;
}

/**
 * Folds sparse evidence events over every cycle length and keeps the best work and recovery
 * phases per cycle. The step between cycle lengths keeps the accumulated drift over the whole
 * track below the fold resolution.
 */
function searchCycles(typed: Curves, durationSec: number, frameSec: number, options: GridOptions): Hypothesis[] {
  const workEvents = peaks(typed.work, frameSec, 0.3, EVENT_MIN);
  const recoveryEvents = peaks(typed.recovery, frameSec, 0.3, EVENT_MIN);
  const minCycle = 2 * options.minIntervalSec;
  const maxCycle = Math.min(options.maxCycleSec, durationSec / (options.minRounds - 0.5));
  const found: Array<Hypothesis & { fold: number }> = [];
  for (let cycle = minCycle; cycle <= maxCycle; cycle += Math.max(0.002, (0.5 * FOLD_BIN_SEC * cycle) / durationSec)) {
    const bins = Math.max(2, Math.round(cycle / FOLD_BIN_SEC));
    const fold = (events: readonly Event[]) => {
      const histogram = new Float64Array(bins);
      let total = 0;
      for (const e of events) {
        const position = ((e.timeSec % cycle) / cycle) * bins;
        const bin = Math.floor(position) % bins;
        histogram[bin] = (histogram[bin] as number) + e.weight;
        histogram[(bin + 1) % bins] = (histogram[(bin + 1) % bins] as number) + 0.5 * e.weight;
        histogram[(bin + bins - 1) % bins] = (histogram[(bin + bins - 1) % bins] as number) + 0.5 * e.weight;
        total += 2 * e.weight;
      }
      return histogram.map((v) => v - total / bins);
    };
    const w = fold(workEvents);
    const r = fold(recoveryEvents);
    const minBins = Math.ceil(options.minIntervalSec / FOLD_BIN_SEC);
    let best: (Hypothesis & { fold: number }) | null = null;
    for (const pw of topBins(w, 6)) {
      for (const pr of topBins(r, 6)) {
        const distance = (pr - pw + bins) % bins;
        if (distance < minBins || bins - distance < minBins) continue;
        const score = (w[pw] as number) + (r[pr] as number);
        if (!best || score > best.fold) best = { cycleSec: cycle, phaseSec: ((pw + 0.5) / bins) * cycle, workSec: (distance / bins) * cycle, fold: score };
      }
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => b.fold - a.fold).slice(0, HYPOTHESES);
}

/** Indices of the `count` largest local maxima. */
function topBins(histogram: Float64Array, count: number): number[] {
  const n = histogram.length;
  const top: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = histogram[i] as number;
    if (v <= 0 || v < (histogram[(i + n - 1) % n] as number) || v < (histogram[(i + 1) % n] as number)) continue;
    let at = top.length;
    while (at > 0 && (histogram[top[at - 1] as number] as number) < v) at--;
    if (at < count) {
      top.splice(at, 0, i);
      if (top.length > count) top.pop();
    }
  }
  return top;
}

/**
 * Exact score of a grid on the frame curves. Rounds without evidence cost a little, so the
 * workout covers the longest run of rounds that the evidence supports as a whole.
 */
function evaluate(h: Hypothesis, scoring: Scoring): Evaluated | null {
  const { work, recovery, durationSec, frameSec, options } = scoring;
  const at = (curve: Float32Array, sec: number) => {
    const f = Math.round(sec / frameSec);
    return f >= 0 && f < curve.length ? (curve[f] as number) : 0;
  };
  const scores: number[] = [];
  const first = Math.ceil(-h.phaseSec / h.cycleSec);
  let k = first;
  for (; h.phaseSec + k * h.cycleSec + h.workSec <= durationSec; k++) {
    const start = h.phaseSec + k * h.cycleSec;
    scores.push(at(work, start) + at(recovery, start + h.workSec) - ROUND_COST);
  }
  // Kadane: the best contiguous run of rounds.
  let bestSum = -Infinity;
  let bestFrom = 0;
  let bestTo = -1;
  let sum = 0;
  let from = 0;
  for (const [i, s] of scores.entries()) {
    if (sum <= 0) {
      sum = 0;
      from = i;
    }
    sum += s;
    if (sum > bestSum) {
      bestSum = sum;
      bestFrom = from;
      bestTo = i;
    }
  }
  if (bestTo < bestFrom || h.workSec < options.minIntervalSec || h.cycleSec - h.workSec < options.minIntervalSec) return null;
  const rounds = bestTo - bestFrom + 1;
  const firstRound = first + bestFrom;
  const contrast = levelSeparation({ ...h, firstRound, rounds }, scoring);
  return { ...h, score: bestSum + (options.volumeWeight * CONTRAST_PER_MINUTE * contrast * rounds * h.cycleSec) / 60, evidence: bestSum, firstRound, rounds };
}

/**
 * How clearly work and recovery differ in level, relative to how much the intervals of one kind
 * differ among themselves (at most ±MAX_CONTRAST). A grid that mixes loud and quiet stretches into
 * one kind, like a half-length cycle, separates poorly.
 */
function levelSeparation(h: Hypothesis & { firstRound: number; rounds: number }, scoring: Scoring): number {
  if (h.rounds < 2) return 0;
  const { level, frameSec } = scoring;
  const mean = (from: number, to: number) => {
    const a = Math.max(0, Math.round((from + LEVEL_MARGIN_SEC) / frameSec));
    const b = Math.min(level.length - 1, Math.round((to - LEVEL_MARGIN_SEC) / frameSec));
    return b > a ? ((level[b] as number) - (level[a] as number)) / (b - a) : Number.NaN;
  };
  const work: number[] = [];
  const recovery: number[] = [];
  for (let k = h.firstRound; k < h.firstRound + h.rounds; k++) {
    const start = h.phaseSec + k * h.cycleSec;
    work.push(mean(start, start + h.workSec));
    if (k < h.firstRound + h.rounds - 1) recovery.push(mean(start + h.workSec, start + h.cycleSec));
  }
  const stats = (values: number[]) => {
    const valid = values.filter((v) => Number.isFinite(v));
    const m = valid.reduce((s, v) => s + v, 0) / Math.max(1, valid.length);
    return { m, v: valid.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, valid.length), n: valid.length };
  };
  const w = stats(work);
  const r = stats(recovery);
  if (w.n === 0 || r.n === 0) return 0;
  return Math.max(-MAX_CONTRAST, Math.min(MAX_CONTRAST, (w.m - r.m) / Math.sqrt((w.v + r.v) / 2 + LEVEL_FLOOR_DB ** 2)));
}

/** Running sums of the level curve, for interval means in constant time. */
function prefixSums(curve: Float32Array): Float64Array {
  const out = new Float64Array(curve.length + 1);
  for (let i = 0; i < curve.length; i++) out[i + 1] = (out[i] as number) + (curve[i] as number);
  return out;
}

interface Scoring {
  readonly work: Float32Array;
  readonly recovery: Float32Array;
  readonly level: Float64Array;
  readonly durationSec: number;
  readonly frameSec: number;
  readonly options: GridOptions;
}

/**
 * Work is not quieter than the recovery before it. A grid that puts a work start where the music
 * clearly drops, or a recovery start where it clearly rises, describes some other structure: an
 * irregular workout that happens to lie near a grid, for example.
 */
function contradictsVolume(structure: WorkoutStructure, curves: EvidenceCurves, countdowns: readonly SpokenCountdown[]): boolean {
  const radius = Math.round(VOLUME_TOLERANCE_SEC / curves.frameSec);
  let contradictions = 0;
  let boundaries = 0;
  for (const interval of structure.intervals) {
    if (interval.startSec <= 0 || interval.type === 'warmup') continue;
    // A coach's voice right there moves the level by itself.
    if (countdowns.some((c) => Math.abs(c.zeroSec - interval.startSec) < VOICE_STEP_SEC)) continue;
    const expected = interval.type === 'work' ? 1 : -1;
    const center = Math.round(interval.startSec / curves.frameSec);
    let strongest = 0;
    for (let f = Math.max(0, center - radius); f <= Math.min(curves.frames - 1, center + radius); f++) {
      if (Math.abs(curves.step[f] as number) > Math.abs(strongest)) strongest = curves.step[f] as number;
    }
    boundaries++;
    if (strongest * expected <= -CONTRADICTION_DB) contradictions++;
  }
  return contradictions >= Math.max(2, CONTRADICTION_SHARE * boundaries);
}

/** The same grid shifted to other phases shows how much a grid scores by chance. */
function significanceOf(fit: Evaluated, scoring: Scoring): number {
  const { work, recovery, frameSec } = scoring;
  const start = fit.phaseSec + fit.firstRound * fit.cycleSec;
  const scores: number[] = [];
  for (let i = 1; i <= NULL_PHASES; i++) {
    const shift = (i / (NULL_PHASES + 1)) * fit.cycleSec;
    const near = (a: number, b: number) => Math.abs(((a - b + 1.5 * fit.cycleSec) % fit.cycleSec) - 0.5 * fit.cycleSec) < 1;
    if (near(shift, 0) || near(shift, fit.workSec) || near(shift, -fit.workSec)) continue;
    let score = 0;
    for (let k = 0; k < fit.rounds; k++) {
      const s = start + shift + k * fit.cycleSec;
      const f = Math.round(s / frameSec) % work.length;
      const g = Math.round((s + fit.workSec) / frameSec) % recovery.length;
      score += (work[f] as number) + (recovery[g] as number) - ROUND_COST;
    }
    scores.push(score);
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) || 1e-6;
  return (fit.evidence - mean) / sd;
}

/**
 * Timing from the precise evidence near the grid's boundaries. Every peak of every precise source
 * is an observation; the grid that most observations agree with (within ~50 ms) wins, so a
 * source that scatters, like word times of a poorly transcribed coach, drops out by itself.
 * Work starts fix start and cycle; recovery starts fix start + work, separately. A final least
 * squares on the agreeing observations gives the exact times.
 */
function refine(fit: Evaluated, typed: Curves, durationSec: number, frameSec: number): Omit<GridFit, 'significance'> {
  const start0 = fit.phaseSec + fit.firstRound * fit.cycleSec;
  const observations: Observation[] = [];
  for (const source of typed.sources) {
    // A sustained cue's curve times it to about 0.15 s; its own band says where it starts.
    const time = (o: Observation) => (source.cueTimed ? { ...o, timeSec: cueStart(typed.curves, o.timeSec) } : o);
    for (let k = 0; k < fit.rounds; k++) {
      if (source.into !== 'recovery') observations.push(...near(source.curve, start0 + k * fit.cycleSec, frameSec, k, 0).map(time));
      if (source.into !== 'work') observations.push(...near(source.curve, start0 + k * fit.cycleSec + fit.workSec, frameSec, k, 1).map(time));
    }
  }
  const work = observations.filter((o) => o.recovery === 0);
  const recovery = observations.filter((o) => o.recovery === 1);
  const agreement = (list: readonly Observation[], offset: number, cycle: number) => {
    let sum = 0;
    for (const o of list) sum += o.weight * Math.exp(-((o.timeSec - offset - o.k * cycle) ** 2) / (2 * AGREEMENT_SEC ** 2));
    return sum;
  };
  let best = { score: -1, start: start0, cycle: fit.cycleSec, workSec: fit.workSec };
  const cycleRange = fit.rounds > 1 ? CYCLE_REFINE_SEC : 0;
  for (let cycle = fit.cycleSec - cycleRange; cycle <= fit.cycleSec + cycleRange + 1e-9; cycle += 0.002) {
    let a = { score: 0, at: start0 };
    let b = { score: 0, at: start0 + fit.workSec };
    for (let d = -REFINE_SEC; d <= REFINE_SEC + 1e-9; d += 0.01) {
      const sa = agreement(work, start0 + d, cycle);
      if (sa > a.score) a = { score: sa, at: start0 + d };
      const sb = agreement(recovery, start0 + fit.workSec + d, cycle);
      if (sb > b.score) b = { score: sb, at: start0 + fit.workSec + d };
    }
    if (a.score + b.score > best.score) best = { score: a.score + b.score, start: a.at, cycle, workSec: b.at - a.at };
  }
  // Least squares on the observations that agree with the best grid.
  const residual = (o: Observation) => o.timeSec - (best.start + o.k * best.cycle + o.recovery * best.workSec);
  const solved = solveGrid(observations.filter((o) => Math.abs(residual(o)) <= INLIER_SEC));
  const startSec = solved?.start ?? best.start;
  return {
    startSec,
    cycleSec: solved?.cycle ?? best.cycle,
    workSec: solved?.work ?? (solved ? best.start + best.workSec - startSec : best.workSec),
    rounds: fit.rounds,
  };
}

interface Observation {
  readonly k: number;
  readonly recovery: number;
  readonly timeSec: number;
  readonly weight: number;
}

/** Local maxima of a curve near a predicted boundary. */
function near(curve: Float32Array, predicted: number, frameSec: number, k: number, recovery: number): Observation[] {
  const center = Math.round(predicted / frameSec);
  const radius = Math.round(REFINE_SEC / frameSec);
  const out: Observation[] = [];
  for (let f = Math.max(1, center - radius); f <= Math.min(curve.length - 2, center + radius); f++) {
    const v = curve[f] as number;
    if (v >= OBSERVATION_MIN && v >= (curve[f - 1] as number) && v > (curve[f + 1] as number)) out.push({ k, recovery, timeSec: f * frameSec, weight: v });
  }
  return out;
}

function solveGrid(rows: ReadonlyArray<{ k: number; recovery: number; timeSec: number; weight: number }>): { start: number; cycle?: number; work?: number } | null {
  if (rows.length === 0) return null;
  const hasWork = rows.some((r) => r.recovery === 0);
  const hasRecovery = rows.some((r) => r.recovery === 1);
  const spread = new Set(rows.map((r) => r.k)).size > 1;
  const columns = (r: (typeof rows)[number]) => [1, ...(spread ? [r.k] : []), ...(hasWork && hasRecovery ? [r.recovery] : [])];
  const size = columns(rows[0] as (typeof rows)[number]).length;
  const a = Array.from({ length: size }, () => new Float64Array(size));
  const b = new Float64Array(size);
  for (const r of rows) {
    const x = columns(r);
    for (let i = 0; i < size; i++) {
      b[i] = (b[i] as number) + r.weight * (x[i] as number) * r.timeSec;
      for (let j = 0; j < size; j++) (a[i] as Float64Array)[j] = ((a[i] as Float64Array)[j] as number) + r.weight * (x[i] as number) * (x[j] as number);
    }
  }
  const solution = solveLinear(a, b);
  if (!solution) return null;
  // Only recovery observations: their offset is start + work, which is all that can be known.
  if (!hasWork) return null;
  return {
    start: solution[0] as number,
    ...(spread ? { cycle: solution[1] as number } : {}),
    ...(hasWork && hasRecovery ? { work: solution[spread ? 2 : 1] as number } : {}),
  };
}

function solveLinear(a: Float64Array[], b: Float64Array): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs((m[row] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) pivot = row;
    if (Math.abs((m[pivot] as number[])[col] as number) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = ((m[row] as number[])[col] as number) / ((m[col] as number[])[col] as number);
      for (let k = col; k <= n; k++) (m[row] as number[])[k] = ((m[row] as number[])[k] as number) - factor * ((m[col] as number[])[k] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

function noWorkout(durationSec: number): WorkoutStructure {
  return {
    pattern: { rounds: 0, regular: false, support: 0 },
    confidence: 0,
    intervals: [
      { index: 0, type: 'other', startSec: 0, endSec: durationSec, confidence: 0, startConfidence: 0, endConfidence: 0, evidence: [], source: 'automatic' },
    ],
  };
}

function describe(fit: GridFit, typed: Curves, curves: EvidenceCurves, durationSec: number, options: GridOptions): WorkoutStructure {
  const frameSec = curves.frameSec;
  const tolerance = Math.round(MATCH_SEC / frameSec);
  const peakNear = (curve: Float32Array, sec: number) => {
    const c = Math.round(sec / frameSec);
    let m = 0;
    for (let f = Math.max(0, c - tolerance); f <= Math.min(curve.length - 1, c + tolerance); f++) m = Math.max(m, curve[f] as number);
    return m;
  };
  const boundaryEvidence = (sec: number, into: 'work' | 'recovery') => {
    const evidence: string[] = [];
    if (peakNear(into === 'work' ? typed.preciseWork : typed.preciseRecovery, sec) - options.cueWeight * peakNear(curves.cue, sec) >= 0.5 * options.countdownWeight) {
      evidence.push('speech:countdown');
    }
    if (peakNear(curves.cue, sec) >= 0.5) evidence.push('acoustic:cue');
    const step = peakNear(into === 'work' ? curves.step : curves.step.map((v) => -v), sec);
    if (step >= 0.5 * VOLUME_UNIT_DB) evidence.push(into === 'work' ? 'acoustic:volume_increase' : 'acoustic:volume_decrease');
    return evidence;
  };
  const confidenceOf = (evidence: readonly string[]) =>
    evidence.some((e) => e !== 'acoustic:volume_increase' && e !== 'acoustic:volume_decrease') ? 0.95 : evidence.length > 0 ? 0.75 : 0.6;

  const boundaries: Array<{ timeSec: number; type: WorkoutInterval['type']; round?: number; evidence: string[] }> = [];
  for (let k = 0; k < fit.rounds; k++) {
    const workStart = fit.startSec + k * fit.cycleSec;
    const workEnd = workStart + fit.workSec;
    boundaries.push({ timeSec: workStart, type: 'work', round: k + 1, evidence: boundaryEvidence(workStart, 'work') });
    const last = k === fit.rounds - 1;
    if (workEnd < durationSec) boundaries.push({ timeSec: workEnd, type: last ? 'cooldown' : 'recovery', ...(last ? {} : { round: k + 1 }), evidence: boundaryEvidence(workEnd, 'recovery') });
  }
  const supported = boundaries.filter((b) => b.evidence.length > 0).length / boundaries.length;
  const overall = clamp01(0.5 + 0.1 * (fit.significance - options.minSignificance)) * (0.5 + 0.5 * supported);

  const starts = [...(fit.startSec > 0 ? [{ timeSec: 0, type: 'warmup' as const, evidence: [] as string[] }] : []), ...boundaries];
  const intervals: WorkoutInterval[] = starts.map((b, i) => {
    const next = starts[i + 1];
    const startConfidence = b.timeSec === 0 ? 1 : confidenceOf(b.evidence) * overall;
    const endConfidence = next ? confidenceOf(next.evidence) * overall : 1;
    return {
      index: i,
      type: b.type,
      startSec: Math.max(0, b.timeSec),
      endSec: next ? next.timeSec : durationSec,
      ...('round' in b && b.round ? { round: b.round } : {}),
      confidence: Math.min(startConfidence, endConfidence),
      startConfidence,
      endConfidence,
      evidence: b.timeSec === 0 ? [] : b.evidence.length > 0 ? b.evidence : ['pattern'],
      source: 'automatic',
    };
  });
  const lastWork = fit.startSec + (fit.rounds - 1) * fit.cycleSec + fit.workSec;
  return {
    pattern: {
      cycleSec: fit.cycleSec,
      workSec: fit.workSec,
      recoverySec: fit.cycleSec - fit.workSec,
      rounds: fit.rounds,
      regular: true,
      support: supported,
    },
    workoutStartSec: Math.max(0, fit.startSec),
    workoutEndSec: Math.min(durationSec, lastWork),
    intervals,
    confidence: overall,
  };
}

/** Evidence peaks as candidate events, kept with each detection for inspection. */
function evidenceEvents(input: GridInput, typed: Curves): CandidateEvent[] {
  const { curves } = input;
  const events: CandidateEvent[] = input.countdowns.map((c) => ({
    timeSec: c.zeroSec,
    type: c.into === 'work' ? 'WorkStart' : c.into === 'recovery' ? 'RecoveryStart' : 'IntervalEnd',
    source: 'speech',
    confidence: 0.9,
    uncertaintySec: COUNTDOWN_SIGMA_SEC,
    evidence: { text: c.text, afterCountdown: true },
  }));
  for (const p of peaks(curves.cue, curves.frameSec, 0.5, 1)) {
    events.push({ timeSec: p.timeSec, type: 'IntervalEnd', source: 'acoustic', confidence: clamp01(p.weight / 2), uncertaintySec: 0.1, evidence: { marker: 'cue' } });
  }
  const up = curves.step.map((v) => Math.max(0, v));
  const down = curves.step.map((v) => Math.max(0, -v));
  for (const [curve, type, marker] of [[up, 'WorkStart', 'volume_increase'], [down, 'RecoveryStart', 'volume_decrease']] as const) {
    for (const p of peaks(curve, curves.frameSec, 2, VOLUME_UNIT_DB / 2)) {
      events.push({ timeSec: p.timeSec, type, source: 'acoustic', confidence: clamp01(p.weight / (2 * VOLUME_UNIT_DB)), uncertaintySec: 0.8, evidence: { marker, db: p.weight } });
    }
  }
  void typed;
  return events.sort((a, b) => a.timeSec - b.timeSec);
}
