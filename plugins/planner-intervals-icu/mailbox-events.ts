// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from 'zod';
import type { MailboxEvent } from './mailbox.ts';

/**
 * What the events of the mailbox mean for the plan (ADR 0079). The payloads are the webhook bodies
 * of intervals.icu, opened by the client: untrusted, so each is checked with zod before use, and
 * an event of a type this client has no use for is dropped. The result says what to change and
 * what to read again; the plugin does the changing.
 */

const id = z.union([z.string(), z.number()]);

const calendarPayload = z
  .object({
    events: z.array(z.record(z.string(), z.unknown())).default([]),
    deleted_events: z.array(z.union([id, z.object({ id }).passthrough()])).default([]),
    oauth_client_id: id.optional(),
  })
  .passthrough();

const activityPayload = z
  .object({
    activity: z.object({ external_id: z.string().nullish() }).passthrough().optional(),
    oauth_client_id: id.optional(),
  })
  .passthrough();

const settingsPayload = z
  .object({
    sportSettings: z.array(z.record(z.string(), z.unknown())).optional(),
    oauth_client_id: id.optional(),
  })
  .passthrough();

const wellnessPayload = z.object({ oauth_client_id: id.optional() }).passthrough();

/** What to do after a set of events. */
export interface Effects {
  /** Planned events to take over (full calendar events) and ids to remove. */
  readonly calendar: { readonly events: Array<Record<string, unknown>>; readonly deleted: string[] };
  /** An FTP the payload carried, and the field of the Ride settings it came from. */
  readonly ftp?: { readonly value: number; readonly field: 'indoor_ftp' | 'ftp' };
  /** Read the athlete's settings again (one request): the payload did not carry the FTP. */
  readonly refreshSettings: boolean;
  /** Read the athlete and today's weight again. */
  readonly refreshAthlete: boolean;
  /** Read the plan and the rides done again. */
  readonly refreshEvents: boolean;
}

/** What this client sent itself: its events come back through the webhook and are not news. */
export interface Own {
  readonly clientId: string;
  /** The external ids of the rides this device uploaded. */
  readonly externalIds: ReadonlySet<string>;
}

/** What was taken over already, so that the same event or an older one changes nothing. */
export interface Applied {
  readonly eventIds: Set<string>;
  /** The timestamp of the mailbox event that last set each calendar event, by its id. */
  readonly calendar: Map<string, string>;
}

export const newApplied = (): Applied => ({ eventIds: new Set(), calendar: new Map() });

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const MAX_REMEMBERED = 500;

/** Interprets events in cursor order; duplicates and older news about the same event change nothing. */
export function interpret(events: readonly MailboxEvent[], own: Own, applied: Applied): Effects {
  const calendar = { events: new Map<string, Record<string, unknown>>(), deleted: new Set<string>() };
  let ftp: Effects['ftp'];
  let refreshSettings = false;
  let refreshAthlete = false;
  let refreshEvents = false;

  for (const event of [...events].sort((a, b) => a.cursor - b.cursor)) {
    if (applied.eventIds.has(event.id)) {
      continue;
    }
    applied.eventIds.add(event.id);
    if (applied.eventIds.size > MAX_REMEMBERED) {
      applied.eventIds.delete(applied.eventIds.values().next().value as string);
    }
    const ours = (clientId: unknown) => clientId !== undefined && String(clientId) === own.clientId;

    if (event.type === 'CALENDAR_UPDATED') {
      const payload = calendarPayload.safeParse(event.payload);
      if (!payload.success || ours(payload.data.oauth_client_id)) {
        continue;
      }
      const newer = (calendarId: string) => {
        const seen = applied.calendar.get(calendarId);
        if (seen !== undefined && seen > event.timestamp) {
          return false;
        }
        applied.calendar.set(calendarId, event.timestamp);
        return true;
      };
      for (const entry of payload.data.events) {
        const calendarId = entry.id === undefined ? undefined : String(entry.id);
        if (calendarId !== undefined && newer(calendarId)) {
          calendar.events.set(calendarId, entry);
          calendar.deleted.delete(calendarId);
        }
      }
      for (const removed of payload.data.deleted_events) {
        const calendarId = String(typeof removed === 'object' ? removed.id : removed);
        if (newer(calendarId)) {
          calendar.deleted.add(calendarId);
          calendar.events.delete(calendarId);
        }
      }
    } else if (event.type === 'SPORT_SETTINGS_UPDATED') {
      const payload = settingsPayload.safeParse(event.payload);
      if (!payload.success || ours(payload.data.oauth_client_id)) {
        continue;
      }
      const ride = payload.data.sportSettings?.find(
        (entry) => Array.isArray(entry.types) && entry.types.includes('Ride'),
      );
      const indoor = positive(ride?.indoor_ftp);
      const outdoor = positive(ride?.ftp);
      if (indoor !== undefined || outdoor !== undefined) {
        ftp = indoor !== undefined ? { value: Math.round(indoor), field: 'indoor_ftp' } : { value: Math.round(outdoor as number), field: 'ftp' };
      } else {
        refreshSettings = true;
      }
    } else if (event.type === 'WELLNESS_UPDATED') {
      const payload = wellnessPayload.safeParse(event.payload);
      if (payload.success && !ours(payload.data.oauth_client_id)) {
        refreshAthlete = true;
      }
    } else if (event.type === 'ACTIVITY_UPLOADED' || event.type === 'ACTIVITY_ANALYZED') {
      const payload = activityPayload.safeParse(event.payload);
      if (!payload.success || ours(payload.data.oauth_client_id)) {
        continue;
      }
      const externalId = payload.data.activity?.external_id;
      if (externalId && own.externalIds.has(externalId)) {
        continue;
      }
      refreshEvents = true;
    }
    // APP_SCOPE_CHANGED and unknown types: nothing to do here.
  }
  return {
    calendar: { events: [...calendar.events.values()], deleted: [...calendar.deleted] },
    ...(ftp ? { ftp } : {}),
    refreshSettings: refreshSettings && ftp === undefined,
    refreshAthlete,
    refreshEvents,
  };
}
