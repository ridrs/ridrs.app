// SPDX-License-Identifier: AGPL-3.0-or-later

/** A climb's category: `4` the easiest, then `3`, `2`, `1` and HC, beyond category. */
export type Category = 'HC' | '1' | '2' | '3' | '4';

/** A route's elevations (m), one every `spacing` m from the start. */
export interface Profile {
  readonly spacing: number;
  readonly elevations: readonly number[];
}

/** A categorised climb: from its foot to its summit, in m along the route. */
export interface Climb {
  readonly category: Category;
  readonly start: number;
  readonly end: number;
  /** m climbed from the foot to the summit, and the average gradient in %, to 0.1. */
  readonly gain: number;
  readonly grade: number;
  /** m above sea level at the summit. */
  readonly summit: number;
  /** The summit's or the climb's name, from the route's notes; none where they name neither. */
  readonly name?: string;
}

/** A note of the control file along the route: m from the start, its text by language. */
export interface Note {
  readonly distance: number;
  readonly text: Readonly<Record<string, string>>;
}

/**
 * The lowest score of each category, highest first (ADR 0070): length in m × average gradient in
 * %, the common stand-in for the Tour's categories, which the Tour sets by hand.
 */
export const CATEGORIES: readonly { readonly category: Category; readonly score: number }[] = [
  { category: 'HC', score: 80_000 },
  { category: '1', score: 64_000 },
  { category: '2', score: 32_000 },
  { category: '3', score: 16_000 },
  { category: '4', score: 8_000 },
];

/** % a climb has on average at least, and m it is long at least, to be categorised. */
const MIN_GRADE = 3;
const MIN_LENGTH = 500;
/** m the road must drop from a summit to end the climb; a smaller dip belongs to it. */
const DIP = 50;
/** % below which the road before the foot is a false flat, step by step or over `RUN_IN` m. */
const FALSE_FLAT = 2;
const RUN_IN = 500;

/** Each rise from a low point to a high point, as indices; a dip of less than `DIP` m does not end one. */
function rises(elevations: readonly number[]): { foot: number; top: number }[] {
  const at = (i: number) => elevations[i] ?? 0;
  const found = [];
  let foot = 0;
  let top = 0;
  for (let i = 1; i < elevations.length; i++) {
    if (at(i) > at(top)) {
      top = i;
    } else if (at(top) - at(i) >= DIP) {
      if (top > foot) found.push({ foot, top });
      foot = i;
      top = i;
    } else if (at(i) < at(foot)) {
      foot = i;
      top = i;
    }
  }
  if (top > foot) found.push({ foot, top });
  return found;
}

/**
 * The foot of a rise: past its false flat, where the next step and the next `RUN_IN` m climb at
 * least `FALSE_FLAT` %; then, if the climb from there averages less than `MIN_GRADE` %, the first
 * point from which the rest of it does.
 */
function footOf({ foot, top }: { foot: number; top: number }, { spacing, elevations }: Profile): number {
  const at = (i: number) => elevations[i] ?? 0;
  const run = Math.max(1, Math.round(RUN_IN / spacing));
  const below = (grade: number, from: number, to: number) =>
    at(to) - at(from) < (grade / 100) * (to - from) * spacing - 1e-9;
  let start = foot;
  while (start < top && (below(FALSE_FLAT, start, start + 1) || below(FALSE_FLAT, start, Math.min(start + run, top)))) {
    start += 1;
  }
  while (start < top && below(MIN_GRADE, start, top)) {
    start += 1;
  }
  return start;
}

/** The categorised climbs of a route, in their order along it. */
export function categoriseClimbs(profile: Profile): Climb[] {
  const { spacing, elevations } = profile;
  const climbs: Climb[] = [];
  for (const rise of rises(elevations)) {
    const foot = footOf(rise, profile);
    const length = (rise.top - foot) * spacing;
    const gain = (elevations[rise.top] ?? 0) - (elevations[foot] ?? 0);
    const grade = length > 0 ? (gain / length) * 100 : 0;
    const category = CATEGORIES.find(({ score }) => length * grade >= score)?.category;
    if (category && length >= MIN_LENGTH && grade >= MIN_GRADE) {
      climbs.push({
        category,
        start: foot * spacing,
        end: rise.top * spacing,
        gain: Math.round(gain),
        grade: Math.round(grade * 10) / 10,
        summit: Math.round(elevations[rise.top] ?? 0),
      });
    }
  }
  return climbs;
}

/** m from a summit within which a note names it. */
const AT_SUMMIT = 300;
/** m before a climb's foot from which a note may announce it. */
const ANNOUNCED = 500;

/** First lines that say where the rider is, not what the place is called. */
const NOT_A_NAME = /^(top of ascent|next\b|more\b|climb\b|first climb|second climb|cycling\.)|to the top|length:/i;
/** An ascent's announcement, e.g. `Rimberg - ascent ca. 6 %` or `Next 3.2 km - Ascent: 186 m`. */
const ASCENT = /\b(ascent|slope)\b/i;

/** The route's own notes at its start: its title with its length, and its license. */
const ABOUT_THE_ROUTE = /length:|licen[sc]e/i;

/** The lines of a note, in English where it has English; none for a note about the whole route. */
function linesOf(note: Note): string[] {
  const text = note.text.en ?? Object.values(note.text)[0] ?? '';
  return ABOUT_THE_ROUTE.test(text) ? [] : text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** A place's name in a line: `Col de Pennes (alt. 1040m)` is the Col de Pennes; none for `Top of ascent`. */
function placeIn(line: string): string | undefined {
  const name = line
    .replace(/\s*\(alt\..*$/i, '')
    .replace(/\s+-\s+(elevation|ascent|bemerkenswert|remarkable).*$/i, '')
    .replace(/:$/, '')
    .trim();
  return name && !NOT_A_NAME.test(name) && !/\d/.test(name) ? name : undefined;
}

/** The name a note gives the summit it stands at: its first line, where that is a place. */
const summitName = (note: Note) => {
  const [first] = linesOf(note);
  return first === undefined ? undefined : placeIn(first);
};

/** The climb an announcing note names: the place before ` - ascent`, or its first line. */
function announcedName(note: Note): string | undefined {
  const lines = linesOf(note);
  if (!lines.some((line) => ASCENT.test(line))) return undefined;
  const before = lines
    .filter((line) => /\s-\s+ascent\b/i.test(line))
    .map((line) => placeIn(line.replace(/\s+-\s+ascent\b.*$/i, '')));
  return before.find((name) => name !== undefined) ?? placeIn(lines[0] ?? '');
}

/**
 * The climbs with the names the route's peaks file or notes give them: a peak named in `peaks` at
 * the climb's index, else a place named within `AT_SUMMIT` m of the summit, else the last
 * announcement of an ascent from `ANNOUNCED` m before the foot to the summit.
 */
export function nameClimbs(
  climbs: readonly Climb[],
  notes: readonly Note[],
  peaks: readonly string[] = [],
): Climb[] {
  return climbs.map(({ name: _, ...climb }, i) => {
    const fromPeaks = peaks[i]?.trim();
    if (fromPeaks) return { ...climb, name: fromPeaks };
    const atSummit = notes
      .filter((note) => Math.abs(note.distance - climb.end) <= AT_SUMMIT)
      .sort((a, b) => Math.abs(a.distance - climb.end) - Math.abs(b.distance - climb.end))
      .map(summitName)
      .find((name) => name !== undefined);
    const announced = notes
      .filter((note) => note.distance >= climb.start - ANNOUNCED && note.distance <= climb.end)
      .map(announcedName)
      .filter((name) => name !== undefined)
      .at(-1);
    const name = atSummit ?? announced;
    return name === undefined ? { ...climb } : { ...climb, name };
  });
}
