// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { allowed, DebugRelay } from './relay.ts';

describe('the debug relay', () => {
  it('resolves an evaluation with the answer of the page', async () => {
    const relay = new DebugRelay();
    const sent: Array<[number, string]> = [];
    const result = relay.evaluate('1 + 1', (id, code) => sent.push([id, code]));
    expect(sent).toHaveLength(1);
    relay.answer(sent[0]?.[0] ?? 0, { ok: true, value: 2 });
    expect(await result).toEqual({ ok: true, value: 2 });
  });

  it('fails an evaluation the page never answers', async () => {
    const relay = new DebugRelay();
    const result = await relay.evaluate('1', () => undefined, 5);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('5 ms');
  });

  it('ignores an answer nobody waits for', () => {
    expect(() => new DebugRelay().answer(99, { ok: true })).not.toThrow();
  });

  it('keeps the last 500 log lines and returns those after a number', () => {
    const relay = new DebugRelay();
    for (let i = 1; i <= 503; i += 1) relay.log('log', `line ${i}`);
    const all = relay.logs();
    expect(all).toHaveLength(500);
    expect(all[0]?.text).toBe('line 4');
    expect(relay.logs(501).map((line) => line.text)).toEqual(['line 502', 'line 503']);
  });
});

describe('who may use the bridge', () => {
  it('needs the token and no origin', () => {
    expect(allowed({ 'x-ridrs-debug-token': 't' }, 't')).toBe(true);
    expect(allowed({}, 't')).toBe(false);
    expect(allowed({ 'x-ridrs-debug-token': 'x' }, 't')).toBe(false);
    expect(allowed({ 'x-ridrs-debug-token': 't', origin: 'https://evil.example' }, 't')).toBe(
      false,
    );
  });
});
