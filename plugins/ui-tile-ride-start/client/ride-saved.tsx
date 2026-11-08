// SPDX-License-Identifier: AGPL-3.0-or-later

import { exportFitState, type RecordingRide, recordingRideState } from '@ridrs/contracts';
import { localizeNumber, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { messages } from './i18n/index.ts';

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
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const [outcome, setOutcome] = useState<RideOutcome>();
  const [fits, setFits] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    // App state (ADR 0069): the rides of this run and their FIT files. The ride shown is the one
    // that changed last; on the first delivery, the newest ride of the run.
    const outcomeOf = (ride: RecordingRide | undefined): RideOutcome => {
      if (ride?.state === 'failed') {
        return { failed: ride.sessionId };
      }
      return ride?.state === 'saved' && ride.file
        ? {
            saved: {
              sessionId: ride.sessionId,
              recording: fileName(ride.file),
              distance: ride.distance,
              durationMs: ride.durationMs ?? 0,
            },
          }
        : undefined;
    };
    const stops = [
      ctx.state.watch(recordingRideState, ({ entries, changed }) => {
        const key = changed.filter((k) => entries.has(k)).at(-1);
        if (key !== undefined) {
          // A deleted ride is no saved ride.
          setOutcome(outcomeOf(entries.get(key)));
        }
      }),
      ctx.state.watch(exportFitState, ({ entries }) =>
        setFits(Object.fromEntries([...entries].map(([key, fit]) => [key, fileName(fit.file)]))),
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
        {text.notSaved}
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
      <strong>{text.saved}</strong>
      <span>
        <span data-testid="ride-saved-distance">
          {saved.distance === undefined ? '–' : localizeNumber((saved.distance / 1000).toFixed(2), language)}
        </span>{' '}
        {text.kmIn} <span data-testid="ride-saved-duration">{formatDuration(saved.durationMs)}</span>
      </span>
      <code data-testid="ride-saved-recording">{saved.recording}</code>
      {fit ? <code data-testid="ride-saved-fit">{fit}</code> : null}
    </section>
  );
}
