// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ActivityState, activityStateChangedEvent } from '@ridrs/contracts';
import { parseRecording, type Recording } from './reader.ts';

/** The part of an open recording a ride can go on from (ADR 0055). */
export interface CommittedJournal {
  /** The committed lines, each ending with a newline. */
  readonly text: string;
  readonly recording: Recording;
  /** The logical time of the last committed event: where the ride was interrupted. */
  readonly lastRecordAt: number;
  /** The ride's running state in the committed part, when there is one. */
  readonly ride?: Extract<ActivityState, { state: 'running' }>;
}

/**
 * The committed part of an open recording: the complete lines, minus every line from the first
 * event of the last event time on. The events of one logical time are then all there or all
 * gone, so a recovery that replays them repeats no turn half. A recording that already has its
 * footer is finished, not interrupted: `undefined`.
 */
export function committedJournal(text: string): CommittedJournal | undefined {
  const open = parseRecording(text, { allowTornLastLine: true, requireFooter: false });
  if (open.footer) {
    return undefined;
  }
  const lines = open.rawLines;
  const times = lines.map((raw) => {
    const record = JSON.parse(raw) as { kind?: string; envelope?: { timestamp?: number } };
    return record.kind === 'event' ? record.envelope?.timestamp : undefined;
  });
  const last = times.findLast((t) => t !== undefined);
  const cut = last === undefined ? lines.length : times.indexOf(last);
  const kept = lines.slice(0, cut);
  const committed = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  const recording = parseRecording(committed, { requireFooter: false });
  const lastRecordAt = recording.events.at(-1)?.envelope.timestamp ?? recording.header.startedAt;
  const ride = recording.events
    .map((e) => e.envelope)
    .filter((e) => e.type === activityStateChangedEvent.id)
    .map((e) => e.payload as ActivityState)
    .find(
      (s): s is Extract<ActivityState, { state: 'running' }> =>
        s.state === 'running' && s.sessionId === recording.header.sessionId,
    );
  return { text: committed, recording, lastRecordAt, ...(ride ? { ride } : {}) };
}
