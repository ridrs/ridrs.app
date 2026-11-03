// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  exportFitWrittenEvent,
  recordingCompletedEvent,
  recordingFailedEvent,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';

interface Saved {
  readonly sessionId: string;
  readonly recording: string;
  readonly distance?: number;
  readonly durationMs: number;
  fit?: string;
}

type RideOutcome = { readonly saved: Saved } | { readonly failed: string } | undefined;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `m:ss` */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "Ride saved" with distance, duration and the files, or that the ride could not be saved. */
export function RideSaved({ ctx }: { readonly ctx: UiContext }) {
  const [outcome, setOutcome] = useState<RideOutcome>();
  const [fits, setFits] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const stops = [
      ctx.events.subscribe(recordingCompletedEvent, ({ payload }) =>
        setOutcome({
          saved: {
            sessionId: payload.sessionId,
            recording: fileName(payload.file),
            distance: payload.distance,
            durationMs: payload.durationMs,
          },
        }),
      ),
      ctx.events.subscribe(recordingFailedEvent, ({ payload }) =>
        setOutcome({ failed: payload.sessionId }),
      ),
      ctx.events.subscribe(exportFitWrittenEvent, ({ payload }) =>
        setFits((known) => ({ ...known, [payload.sessionId]: fileName(payload.file) })),
      ),
    ];
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, [ctx]);

  if (!outcome) {
    return null;
  }
  if ('failed' in outcome) {
    return (
      <section data-testid="ride-not-saved" role="status">
        Ride could not be saved
      </section>
    );
  }
  const { saved } = outcome;
  const fit = fits[saved.sessionId];
  return (
    <section
      data-testid="ride-saved"
      role="status"
      style={{ display: 'grid', gap: 4, textAlign: 'center', fontSize: 18 }}
    >
      <strong>Ride saved</strong>
      <span>
        <span data-testid="ride-saved-distance">
          {saved.distance === undefined ? '–' : (saved.distance / 1000).toFixed(2)}
        </span>{' '}
        km in <span data-testid="ride-saved-duration">{formatDuration(saved.durationMs)}</span>
      </span>
      <code data-testid="ride-saved-recording">{saved.recording}</code>
      {fit ? <code data-testid="ride-saved-fit">{fit}</code> : null}
    </section>
  );
}
