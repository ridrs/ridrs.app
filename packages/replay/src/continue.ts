// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityInterruptedEvent, defineEvent, type EventEnvelope } from '@ridrs/contracts';
import { PluginHost, type PluginHostOptions } from '@ridrs/core';
import { committedJournal } from '@ridrs/recording';
import { z } from 'zod';
import { recordedInputs } from './replay.ts';

/** The source of the interruption a continuation injects. */
export const RECOVERY_SOURCE = 'ridrs-recovery';

export interface ContinueRecordingOptions
  extends Omit<PluginHostOptions, 'replay' | 'continueFrom'> {
  /** The open recording (`.ridrs.jsonl`) the ride goes on in. */
  readonly file: string;
  /** Runs before the host starts: a composition root attaches its UI bridge and taps here. */
  readonly beforeStart?: (host: PluginHost) => void;
}

/**
 * Continues an interrupted ride (ADR 0057): composes a host held at the ride's start with the
 * recorded run id, starts every plugin, re-executes the committed inputs at their recorded times,
 * injects `activity.interrupted` where the journal ends, and hands the clock to the live time
 * source. The ride is then paused with its session, distance and step numbers; the recorder
 * appends to the same file.
 */
export async function continueRecording(
  text: string,
  options: ContinueRecordingOptions,
): Promise<PluginHost> {
  const journal = committedJournal(text);
  const runId = journal?.recording.header.runId;
  if (!journal?.ride || !runId) {
    throw new Error(`"${options.file}" holds no ride that can go on`);
  }
  const { recording, lastRecordAt } = journal;
  const { beforeStart, file, ...hostOptions } = options;
  const start = Math.min(
    recording.header.startedAt,
    recording.events[0]?.envelope.timestamp ?? recording.header.startedAt,
  );
  const host = new PluginHost({ ...hostOptions, continueFrom: { start, runId, file } });
  beforeStart?.(host);
  await host.start();
  const recordedIds = new Set(
    ((recording.snapshot.host as { plugins?: { id: string }[] }).plugins ?? []).map((p) => p.id),
  );
  for (const { envelope } of recordedInputs(recording, recordedIds)) {
    host.injectInput(
      envelope as EventEnvelope,
      host.getEventDefinition(envelope.type) ?? defineEvent(envelope.type, z.unknown()),
    );
  }
  host.advanceTo(lastRecordAt);
  host.publishEvent(RECOVERY_SOURCE, activityInterruptedEvent, {});
  host.advanceTo(lastRecordAt);
  host.goLive();
  return host;
}
