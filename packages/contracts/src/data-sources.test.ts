// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  athleteProfileState,
  athleteProfileUpdateService,
  dataSelectService,
  dataSourceState,
  defineDataType,
} from './index.ts';

describe('defineDataType (ADR 0075)', () => {
  const note = defineDataType('test.note', z.object({ text: z.string() }).strict(), {
    set: z.object({ text: z.string() }).strict(),
    clear: z.object({}).strict(),
  });

  it('defines the topic by the data type and one keyed service per write', () => {
    expect(note.topic.id).toBe('test.note');
    expect(Object.keys(note.writes)).toEqual(['set', 'clear']);
    expect(note.writes.set.id).toBe('test.note.set');
    expect(note.writes.set.keyedBy).toBe(note.topic);
  });

  it('defines no service for a type that cannot be written', () => {
    expect(defineDataType('test.read-only', z.object({}), {}).writes).toEqual({});
  });

  it('takes a source with its status, label and data, and nothing else', () => {
    const source = {
      provider: 'intervals.icu',
      label: 'intervals.icu',
      status: 'offline',
      writable: false,
    };
    expect(
      note.topic.schema.safeParse({ ...source, fetchedAt: 1, data: { text: 'a' } }).success,
    ).toBe(true);
    expect(note.topic.schema.safeParse(source).success).toBe(true);
    expect(note.topic.schema.safeParse({ ...source, status: 'broken' }).success).toBe(false);
    expect(note.topic.schema.safeParse({ ...source, data: { text: 1 } }).success).toBe(false);
    expect(note.topic.schema.safeParse({ ...source, extra: 1 }).success).toBe(false);
  });

  it('asks a write for the provider as `key`, and answers done or refused', () => {
    expect(note.writes.set.request.safeParse({ key: 'ridrs', text: 'a' }).success).toBe(true);
    expect(note.writes.set.request.safeParse({ text: 'a' }).success).toBe(false);
    expect(note.writes.set.response.safeParse({ ok: true }).success).toBe(true);
    expect(note.writes.set.response.safeParse({ ok: false, reason: 'read-only' }).success).toBe(
      true,
    );
    expect(note.writes.set.response.safeParse({ ok: false, reason: 'because' }).success).toBe(
      false,
    );
  });
});

describe('the athlete profile', () => {
  it('is the topic athlete.profile and the service athlete.profile.update', () => {
    expect(athleteProfileState.id).toBe('athlete.profile');
    expect(athleteProfileUpdateService.id).toBe('athlete.profile.update');
    expect(athleteProfileUpdateService.keyedBy).toBe(athleteProfileState);
  });

  it('changes part of the profile, never the name', () => {
    const request = athleteProfileUpdateService.request;
    expect(request.safeParse({ key: 'ridrs', weight: 81.5 }).success).toBe(true);
    expect(
      request.safeParse({ key: 'ridrs', ftp: 250, lthr: 160, maxHeartRate: 185 }).success,
    ).toBe(true);
    expect(request.safeParse({ key: 'ridrs', name: 'Alex' }).success).toBe(false);
    expect(request.safeParse({ key: 'ridrs', ftp: -1 }).success).toBe(false);
  });

  it('may carry the name of the provider', () => {
    const source = { provider: 'intervals.icu', label: 'x', status: 'ready', writable: true };
    expect(
      athleteProfileState.schema.safeParse({ ...source, data: { name: 'Alex Rider', ftp: 250 } })
        .success,
    ).toBe(true);
  });
});

describe('the choice of a source', () => {
  it('is keyed by the data type and selected by a keyed service', () => {
    expect(dataSourceState.id).toBe('data.source');
    expect(dataSelectService.keyedBy).toBe(dataSourceState);
    expect(
      dataSelectService.request.safeParse({ key: 'athlete.profile', provider: 'ridrs' }).success,
    ).toBe(true);
    expect(
      dataSelectService.request.safeParse({ key: 'athlete.profile', provider: 'No Way' }).success,
    ).toBe(false);
  });
});
