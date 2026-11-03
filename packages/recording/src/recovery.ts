// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RecordingFooter } from '@ridrs/contracts';
import { lastRecordTime, parseRecording, type Recording } from './reader.ts';

export interface RecoveredRecording {
  /** The complete JSON Lines text: the valid lines and a footer. */
  readonly text: string;
  readonly recording: Recording;
}

/**
 * Completes an open recording left behind by a crash: drops a torn last line and appends a
 * `recovered` footer whose end is the last record's time. A file that already has its footer
 * (a crash between footer and compression) is kept as it is.
 */
export function recoverRecording(text: string): RecoveredRecording {
  const open = parseRecording(text, { allowTornLastLine: true, requireFooter: false });
  if (open.footer) {
    return { text: `${open.rawLines.join('\n')}\n`, recording: open };
  }
  const byType: Record<string, number> = {};
  let lastSeq = 0;
  for (const event of open.events) {
    byType[event.envelope.type] = (byType[event.envelope.type] ?? 0) + 1;
    lastSeq = Math.max(lastSeq, event.seq);
  }
  for (const diagnostic of open.diagnostics) {
    lastSeq = Math.max(lastSeq, diagnostic.seq);
  }
  const footer: RecordingFooter = {
    kind: 'footer',
    status: 'recovered',
    endedAt: lastRecordTime(open),
    lastSeq,
    counts: {
      events: open.events.length,
      diagnostics: open.diagnostics.length,
      byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
  const lines = [...open.rawLines, JSON.stringify(footer)];
  const completed = `${lines.join('\n')}\n`;
  return { text: completed, recording: parseRecording(completed) };
}
