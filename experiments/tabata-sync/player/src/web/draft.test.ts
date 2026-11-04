// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { finalizeDraft, gridDraft, markChange, placeMark, removeBoundary, structureOf } from './draft.ts';

describe('correction drafts', () => {
  const detected = [
    { atSec: 0, type: 'warmup' as const },
    { atSec: 8.1, type: 'work' as const },
    { atSec: 32.2, type: 'recovery' as const },
    { atSec: 38.6, type: 'work' as const },
    { atSec: 63, type: 'recovery' as const },
  ];

  it('moves the nearby boundary of the same type, or adds one', () => {
    let draft = placeMark(detected, 10.04, 'work');
    draft = placeMark(draft, 30, 'recovery');
    expect(draft.map((b) => b.atSec)).toEqual([0, 10.04, 30, 38.6, 63]);
    // Nothing of that type nearby: a new boundary.
    draft = placeMark(draft, 50, 'recovery');
    expect(draft.map((b) => [b.atSec, b.type])).toEqual([
      [0, 'warmup'],
      [10.04, 'work'],
      [30, 'recovery'],
      [38.6, 'work'],
      [50, 'recovery'],
      [63, 'recovery'],
    ]);
    // The warm-up at 0 never moves.
    expect(placeMark(draft, 2, 'warmup')[0]?.atSec).toBe(0);
  });

  it('turns a tap into the nearest boundary or the next phase', () => {
    let draft = markChange(detected, 10);
    draft = markChange(draft, 30);
    expect(draft.map((b) => [b.atSec, b.type])).toEqual([
      [0, 'warmup'],
      [10, 'work'],
      [30, 'recovery'],
      [38.6, 'work'],
      [63, 'recovery'],
    ]);
    // Far from any boundary inside recovery 63–: the next work starts.
    expect(markChange(draft, 75).at(-1)).toEqual({ atSec: 75, type: 'work' });
    expect(markChange([{ atSec: 0, type: 'warmup' }, { atSec: 10, type: 'work' }], 30).at(-1)).toEqual({ atSec: 30, type: 'recovery' });
  });

  it('ends a tapped workout with the cooldown', () => {
    const tapped = markChange(markChange([{ atSec: 0, type: 'warmup' }], 10), 30);
    expect(finalizeDraft(tapped).at(-1)).toEqual({ atSec: 30, type: 'cooldown' });
    expect(structureOf(tapped, 40).intervals.at(-1)?.type).toBe('cooldown');
    expect(finalizeDraft(gridDraft(10, 20, 10, 2))).toEqual(gridDraft(10, 20, 10, 2));
  });

  it('describes a regular grid and merges same-type neighbors', () => {
    const draft = gridDraft(10, 20, 10, 8);
    expect(draft.at(-1)).toEqual({ atSec: 240, type: 'cooldown' });
    const structure = structureOf(draft, 242);
    expect(structure.pattern.rounds).toBe(8);
    expect(structure.intervals.filter((i) => i.type === 'recovery')).toHaveLength(7);

    const merged = structureOf(removeBoundary(draft, 2), 242);
    expect(merged.intervals[1]).toMatchObject({ type: 'work', startSec: 10, endSec: 60 });
  });
});
