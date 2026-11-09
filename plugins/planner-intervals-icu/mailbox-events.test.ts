// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { MailboxEvent } from './mailbox.ts';
import { interpret, newApplied, type Own } from './mailbox-events.ts';

const own: Own = { clientId: '1697', externalIds: new Set(['session-1']) };
let cursor = 0;
const event = (type: string, payload: unknown, timestamp = '2026-11-04T10:00:00', id?: string): MailboxEvent => {
  cursor += 1;
  return { cursor, id: id ?? `e${cursor}`, type, timestamp, payload };
};

describe('what a mailbox event means', () => {
  it('takes over the events and deletions of a calendar change', () => {
    const effects = interpret(
      [event('CALENDAR_UPDATED', { events: [{ id: 1, name: 'A' }], deleted_events: [2, { id: 3 }] })],
      own,
      newApplied(),
    );
    expect(effects.calendar).toEqual({ events: [{ id: 1, name: 'A' }], deleted: ['2', '3'] });
  });

  it('ignores the echo of our own writes, by client id and by external id', () => {
    const effects = interpret(
      [
        event('CALENDAR_UPDATED', { oauth_client_id: 1697, events: [{ id: 1 }] }),
        event('ACTIVITY_UPLOADED', { activity: { external_id: 'session-1' } }),
        event('ACTIVITY_UPLOADED', { oauth_client_id: '1697' }),
      ],
      own,
      newApplied(),
    );
    expect(effects.calendar.events).toEqual([]);
    expect(effects.refreshEvents).toBe(false);
  });

  it('applies an event once, and the newest timestamp wins for a calendar event', () => {
    const applied = newApplied();
    const newer = event('CALENDAR_UPDATED', { events: [], deleted_events: [9] }, '2026-11-04T10:05:00');
    const older = event('CALENDAR_UPDATED', { events: [{ id: 9, name: 'Old' }] }, '2026-11-04T10:00:00');
    const first = interpret([newer, older], own, applied);
    expect(first.calendar).toEqual({ events: [], deleted: ['9'] });
    expect(interpret([newer], own, applied).calendar.deleted).toEqual([]);
  });

  it('applies the FTP of the settings, or reads them again when the payload has none', () => {
    const withFtp = interpret(
      [event('SPORT_SETTINGS_UPDATED', { sportSettings: [{ types: ['Ride'], indoor_ftp: 241.6, ftp: 250 }] })],
      own,
      newApplied(),
    );
    expect(withFtp.ftp).toEqual({ value: 242, field: 'indoor_ftp' });
    expect(withFtp.refreshSettings).toBe(false);
    const without = interpret([event('SPORT_SETTINGS_UPDATED', {})], own, newApplied());
    expect(without.ftp).toBeUndefined();
    expect(without.refreshSettings).toBe(true);
  });

  it('marks what to read again for wellness and activities, and drops what it does not know', () => {
    const effects = interpret(
      [event('WELLNESS_UPDATED', {}), event('ACTIVITY_ANALYZED', {}), event('APP_SCOPE_CHANGED', {}), event('SOMETHING_NEW', {})],
      own,
      newApplied(),
    );
    expect(effects.refreshAthlete).toBe(true);
    expect(effects.refreshEvents).toBe(true);
  });

  it('drops a payload that does not have the shape', () => {
    const effects = interpret([event('CALENDAR_UPDATED', { events: 'nope' }), event('WELLNESS_UPDATED', 7)], own, newApplied());
    expect(effects.calendar.events).toEqual([]);
    expect(effects.refreshAthlete).toBe(false);
  });
});
