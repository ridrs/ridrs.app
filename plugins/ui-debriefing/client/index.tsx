// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  exportFitState,
  type RecordingRide,
  recordingDeleteService,
  recordingRideState,
  type TrainingAccount,
  type TrainingUpload,
  trainingAccountState,
  trainingConnectService,
  trainingUploadService,
  trainingUploadState,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** The planning service the rides go to: its key in the app state (ADR 0068). */
const SERVICE = 'intervals.icu';

/** The screens this plugin moves between. */
const MAIN = 'main';
const ACTIVITY = 'activity';

/** The look of the training plan and the device setup (docs/ux-draft). Plugins share no code. */
const COLORS = {
  panel: '#0a1520',
  line: '#1f3447',
  cyan: '#27c8ff',
  lime: '#8dff2a',
  amber: '#ffb62e',
  muted: '#8b9db2',
  red: '#ff4d5e',
} as const;

const CSS = `
.db-screen { box-sizing: border-box; display: flex; flex-direction: column; gap: 22px; height: 100%;
  max-width: 640px; margin: 0 auto; padding: 48px 24px; overflow-y: auto;
  color: var(--ridrs-text, #fff); font: 500 15px system-ui, sans-serif; }
.db-screen h1 { margin: 0; font-size: 34px; }
.db-facts { display: flex; gap: 32px; margin: 0; }
.db-facts div { display: flex; flex-direction: column; gap: 2px; }
.db-facts dt { color: ${COLORS.muted}; font-size: 13px; }
.db-facts dd { margin: 0; font-size: 26px; font-weight: 700; }
.db-note { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: ${COLORS.muted}; }
.db-warn { color: ${COLORS.amber}; }
.db-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.db-button { padding: 12px 26px; border: 1.5px solid ${COLORS.line}; border-radius: 999px;
  background: ${COLORS.panel}; color: #fff; font: 600 16px system-ui, sans-serif; cursor: pointer; }
.db-primary { border-color: ${COLORS.lime}; background: ${COLORS.lime}; color: #0a1520; }
.db-delete { color: ${COLORS.red}; }
.db-button:hover { border-color: ${COLORS.cyan}; }
.db-button:focus-visible { outline: 2px solid ${COLORS.lime}; outline-offset: 3px; }
.db-button:disabled { opacity: .5; cursor: default; }
.db-spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid ${COLORS.cyan}40; border-top-color: ${COLORS.cyan}; animation: db-spin 1s linear infinite; }
@keyframes db-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .db-spin { animation: none; } }
`;

/** What became of the ride's recording: still being written, written, or lost. */
type Recording =
  | { readonly state: 'pending' }
  | { readonly state: 'saved'; readonly file: string; readonly distance?: number; readonly durationMs: number }
  | { readonly state: 'failed' };

const FAILURES: Record<NonNullable<TrainingUpload['reason']>, string> = {
  'not-connected': 'intervals.icu is not connected.',
  'token-rejected': 'intervals.icu asks you to connect again.',
  unreachable: 'intervals.icu could not be reached.',
  rejected: 'intervals.icu did not accept the ride.',
};

/** `h:mm:ss`, or `m:ss` under an hour. */
function durationLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** A ride of the app state as the debriefing shows it; a deleted ride is none. */
function recordingOf(key: string, ride: RecordingRide): [string, Recording][] {
  if (ride.state === 'failed') {
    return [[key, { state: 'failed' }]];
  }
  return ride.state === 'saved' && ride.file
    ? [
        [
          key,
          {
            state: 'saved',
            file: ride.file,
            durationMs: ride.durationMs ?? 0,
            ...(ride.distance !== undefined ? { distance: ride.distance } : {}),
          },
        ],
      ]
    : [];
}

/**
 * The ride's session and everything the host reports about it. A component that mounts later
 * gets every ride of the run and the latest activity state, so values of an earlier ride are
 * filtered by the session.
 */
function useDebriefing(ctx: UiContext) {
  const [sessionId, setSessionId] = useState<string>();
  const [recordings, setRecordings] = useState<Readonly<Record<string, Recording>>>({});
  const [fits, setFits] = useState<Readonly<Record<string, string>>>({});
  const [uploads, setUploads] = useState<Readonly<Record<string, TrainingUpload>>>({});
  const [account, setAccount] = useState<TrainingAccount>();
  useLayoutEffect(() => {
    const subscriptions = [
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'finished') {
          setSessionId(payload.sessionId);
        } else if (payload.state === 'running' || payload.state === 'paused') {
          // A ride started elsewhere (a second window) leads into the ride.
          ctx.navigate(ACTIVITY);
        } else {
          ctx.navigate(MAIN);
        }
      }),
      // App state (ADR 0068, ADR 0069): every ride of the run, its FIT file and its upload by
      // its session, and the account.
      ctx.state.watch(recordingRideState, ({ entries }) =>
        setRecordings(Object.fromEntries([...entries].flatMap(([key, ride]) => recordingOf(key, ride)))),
      ),
      ctx.state.watch(exportFitState, ({ entries }) =>
        setFits(Object.fromEntries([...entries].map(([key, fit]) => [key, fit.file]))),
      ),
      ctx.state.watch(trainingUploadState, ({ entries }) => setUploads(Object.fromEntries(entries))),
      ctx.state.watch(trainingAccountState, ({ entries }) => setAccount(entries.get(SERVICE))),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [ctx]);
  return {
    sessionId,
    recording: (sessionId && recordings[sessionId]) || ({ state: 'pending' } as const),
    fit: sessionId ? fits[sessionId] : undefined,
    upload: sessionId ? uploads[sessionId] : undefined,
    account,
  };
}

function DebriefingView({ ctx }: { readonly ctx: UiContext }) {
  const { sessionId, recording, fit, upload, account } = useDebriefing(ctx);
  const save = useRef<HTMLButtonElement>(null);
  // How often Save (or Try again) was pressed: each attempt uploads once the FIT file is written.
  // The recording and its FIT file are written in the background: Save never waits for them.
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(0);
  const saving = attempt > 0;
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Why the last upload call was refused: no upload started, the ride stays here.
  const [refused, setRefused] = useState<string>();
  const connected = account?.state === 'connected';

  // Back never throws a ride away or leaves it undecided: it offers Save, which Enter confirms.
  useEffect(
    () =>
      ctx.onBack(() => {
        setConfirmDelete(false);
        save.current?.focus();
      }),
    [ctx],
  );

  useEffect(() => {
    if (attempt > requested.current && fit && sessionId) {
      requested.current = attempt;
      ctx
        .call(trainingUploadService, { key: SERVICE, sessionId, file: fit })
        .catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)));
    }
  }, [ctx, attempt, fit, sessionId]);

  useEffect(() => {
    if (saving && upload?.state === 'uploaded') {
      ctx.navigate(MAIN);
    }
  }, [ctx, saving, upload?.state]);

  const decided = recording.state !== 'pending';
  const uploading = saving && refused === undefined && upload?.state !== 'failed';
  const failed = saving && upload?.state === 'failed' ? upload : undefined;
  const tryAgain = failed !== undefined || refused !== undefined;
  // After a failed upload without an account, the rider connects first: Try again waits for it.
  const reconnect = failed !== undefined && !connected;

  const saveDisabled = uploading || reconnect;

  // Save takes the focus once it can be pressed, and again when Delete is not confirmed: the
  // button is only there again after that render.
  useEffect(() => {
    if (!saveDisabled && !confirmDelete) {
      save.current?.focus();
    }
  }, [saveDisabled, confirmDelete]);

  const onSave = () => {
    // Without an account, or with a recording that failed, there is nothing to upload: the ride
    // stays on this device. Otherwise the upload starts once the FIT file is there, now or soon.
    if (!connected || recording.state === 'failed') {
      ctx.navigate(MAIN);
      return;
    }
    setRefused(undefined);
    setAttempt((count) => count + 1);
  };

  // Delete, confirmed: the ride goes once its recording is written; the rider never waits for it.
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!deleting || !decided) {
      return;
    }
    if (sessionId && recording.state === 'saved') {
      ctx
        .call(recordingDeleteService, { key: sessionId })
        .catch((error: unknown) => ctx.logger.warn('The ride could not be deleted', error));
    }
    ctx.navigate(MAIN);
  }, [ctx, deleting, decided, sessionId, recording.state]);
  const onDelete = () => setDeleting(true);

  return (
    <main className="db-screen" data-testid="debriefing">
      <style>{CSS}</style>
      <h1>Ride finished</h1>
      {recording.state === 'saved' ? (
        <dl className="db-facts">
          <div>
            <dt>Distance</dt>
            <dd data-testid="debriefing-distance">
              {recording.distance === undefined ? '–' : `${(recording.distance / 1000).toFixed(2)} km`}
            </dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd data-testid="debriefing-duration">{durationLabel(recording.durationMs)}</dd>
          </div>
        </dl>
      ) : null}
      <div role="status" data-testid="debriefing-status">
        {recording.state === 'failed' ? (
          <p className="db-note db-warn">The ride could not be recorded.</p>
        ) : uploading ? (
          <p className="db-note">
            <span className="db-spin" aria-hidden="true" />
            Uploading to intervals.icu…
          </p>
        ) : refused !== undefined ? (
          <p className="db-note db-warn">{refused} The ride is kept on this device.</p>
        ) : failed ? (
          <p className="db-note db-warn">
            {failed.reason ? FAILURES[failed.reason] : 'The upload failed.'} The ride is kept on this device.
          </p>
        ) : connected ? (
          <p className="db-note">
            Save uploads the ride to intervals.icu{account?.athleteName ? ` as ${account.athleteName}` : ''}.
          </p>
        ) : (
          <p className="db-note">Save keeps the ride on this device. Connect intervals.icu in Me to upload rides.</p>
        )}
      </div>
      {confirmDelete ? (
        <div className="db-actions" role="group" aria-label="Delete this ride?">
          <p className="db-note db-warn" style={{ flexBasis: '100%' }}>
            Delete this ride? It cannot be brought back.
          </p>
          <button type="button" className="db-button db-delete" onClick={onDelete}>
            Delete ride
          </button>
          <button
            type="button"
            className="db-button"
            onClick={() => setConfirmDelete(false)}
          >
            Keep ride
          </button>
        </div>
      ) : (
        <div className="db-actions">
          <button
            ref={save}
            type="button"
            className="db-button db-primary"
            disabled={saveDisabled}
            onClick={onSave}
          >
            {tryAgain ? 'Try again' : 'Save'}
          </button>
          {reconnect ? (
            <button
              type="button"
              className="db-button"
              disabled={account?.state === 'connecting'}
              onClick={() =>
                ctx
                  .call(trainingConnectService, { key: SERVICE })
                  .catch((error: unknown) => ctx.logger.warn('intervals.icu: connecting was refused', error))
              }
            >
              {failed?.reason === 'token-rejected' ? 'Reconnect intervals.icu' : 'Connect intervals.icu'}
            </button>
          ) : null}
          {tryAgain ? (
            <button type="button" className="db-button" onClick={() => ctx.navigate(MAIN)}>
              Save without upload
            </button>
          ) : null}
          <button
            type="button"
            className="db-button db-delete"
            disabled={uploading || deleting}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        </div>
      )}
    </main>
  );
}

export const DebriefingScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<DebriefingView ctx={ctx} />);
  return () => root.unmount();
};
