// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { begin, commit, redo, seal, undo } from './history.ts';

describe('history', () => {
  it('undoes and redoes, and a new edit forgets what was undone', () => {
    let h = commit(commit(begin('a'), 'b'), 'c');
    h = undo(undo(h));
    expect(h.present).toBe('a');
    expect(redo(h).present).toBe('b');
    expect(commit(undo(redo(h)), 'x').future).toEqual([]);
    expect(undo(begin('a')).present).toBe('a');
  });

  it('joins edits of one field into one step until sealed', () => {
    let h = commit(commit(commit(begin(1), 3, 'f'), 35, 'f'), 350, 'f');
    expect(h.past).toEqual([1]);
    h = commit(seal(h), 351, 'f');
    expect(h.past).toEqual([1, 350]);
    expect(commit(h, 2, 'g').past).toEqual([1, 350, 351]);
  });

  it('ignores an edit that changes nothing', () => {
    const h = begin('a');
    expect(commit(h, 'a')).toBe(h);
  });
});
