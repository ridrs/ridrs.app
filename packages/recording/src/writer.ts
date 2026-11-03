// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Diagnostic,
  EventEnvelope,
  RecordingFooter,
  RecordingHeader,
  RecordingSnapshot,
} from '@ridrs/contracts';

/** An envelope serialized when it was observed: later changes to its payload cannot leak in. */
export interface SerializedEnvelope {
  readonly type: string;
  readonly timestamp: number;
  /** `{ id, type, source, timestamp, payload, seq, input?, receivedAt? }` as JSON. */
  readonly json: string;
}

export function serializeEnvelope(envelope: EventEnvelope): SerializedEnvelope {
  const { id, type, source, timestamp, payload, seq, input, receivedAt } = envelope;
  return {
    type,
    timestamp,
    json: JSON.stringify({ id, type, source, timestamp, payload, seq, input, receivedAt }),
  };
}

/**
 * Turns one ride into ridrs recording v1 lines: numbers events and diagnostics with one shared
 * `seq` and counts them for the footer. Pure: it never touches storage.
 */
export class RecordingWriter {
  private seq = 0;
  private events = 0;
  private diagnostics = 0;
  private readonly byType = new Map<string, number>();

  header(header: Omit<RecordingHeader, 'kind'>): string {
    return line({ kind: 'header', ...header });
  }

  snapshot(snapshot: Omit<RecordingSnapshot, 'kind'>): string {
    return line({ kind: 'snapshot', ...snapshot });
  }

  event(envelope: SerializedEnvelope, preroll: boolean): string {
    this.seq += 1;
    this.events += 1;
    this.byType.set(envelope.type, (this.byType.get(envelope.type) ?? 0) + 1);
    return `{"kind":"event","seq":${this.seq},"preroll":${preroll},"envelope":${envelope.json}}\n`;
  }

  diagnostic(diagnostic: Diagnostic, at: number): string {
    this.seq += 1;
    this.diagnostics += 1;
    const { code, pluginId, message, details } = diagnostic;
    return line({ kind: 'diagnostic', seq: this.seq, at, code, pluginId, message, details });
  }

  footer(status: RecordingFooter['status'], endedAt: number): string {
    return line({ kind: 'footer', ...this.summary(status, endedAt) });
  }

  summary(status: RecordingFooter['status'], endedAt: number): Omit<RecordingFooter, 'kind'> {
    return {
      status,
      endedAt,
      lastSeq: this.seq,
      counts: {
        events: this.events,
        diagnostics: this.diagnostics,
        byType: Object.fromEntries([...this.byType].sort(([a], [b]) => a.localeCompare(b))),
      },
    };
  }

  /** Events written so far. */
  eventCount(): number {
    return this.events;
  }
}

function line(record: object): string {
  return `${JSON.stringify(record)}\n`;
}
