// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityAthleteEvent,
  activityFinishRequestedEvent,
  activityStateChangedEvent,
  activityWorkoutRequestedEvent,
  activityWorldRequestedEvent,
  appLinkState,
  athleteProfileState,
  dataSourceState,
  exportFitState,
  type RecordingRide,
  type RideWorkout,
  type RideWorld,
  recordingDeleteService,
  recordingRideState,
  routeOfferState,
  type TrainingAccount,
  type TrainingUpload,
  trainingAccountState,
  trainingCalendarState,
  trainingConnectService,
  trainingLibraryState,
  trainingUploadService,
  trainingUploadState,
  trashItemState,
  withoutBinned,
} from '@ridrs/contracts';
import { localizeNumber, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';
import {
  availableWorkouts,
  offerOf,
  type Refusal,
  resolveAthlete,
  resolveWorkoutForRide,
  sameRideWorkout,
  sameWorld,
} from './menu-choice.ts';

/** The planning service the rides go to: its key in the app state (ADR 0068). */
const SERVICE = 'intervals.icu';

/** The screens this plugin moves between. */
const MAIN = 'main';
const ACTIVITY = 'activity';
/** Screens of other plugins the activity menu opens, when they are there (ADR 0098, ADR 0108). */
const SETTINGS = 'settings';
const DEVICES = 'setup';

/** The unified look (docs/design/unified), as tokens. Plugins share no code. */
const COLORS = {
  panel: 'var(--ridrs-card-quiet)',
  line: 'var(--ridrs-line)',
  cyan: 'var(--ridrs-info)',
  lime: 'var(--ridrs-accent)',
  amber: 'var(--ridrs-warn)',
  muted: 'var(--ridrs-text-muted)',
  red: 'var(--ridrs-danger)',
} as const;

const CSS = `
.db-screen { box-sizing: border-box; display: flex; flex-direction: column; gap: 22px; height: 100%;
  max-width: 640px; margin: 0 auto; padding: 40px 24px; overflow-y: auto;
  color: var(--ridrs-text); font: 500 15px var(--ridrs-font-text); }
.db-screen h1 { margin: 0; font-size: 32px; }
.db-facts { display: flex; flex-wrap: wrap; gap: var(--ridrs-gap); margin: 0; }
.db-facts div { display: flex; flex-direction: column; gap: 2px; min-width: 140px; padding: 14px 20px;
  border-radius: var(--ridrs-radius-lg); background: var(--ridrs-card); box-shadow: var(--ridrs-edge), var(--ridrs-shadow); }
.db-facts dt { color: var(--ridrs-info); font: 500 var(--ridrs-size-label) var(--ridrs-font-mono);
  letter-spacing: .12em; text-transform: uppercase; }
.db-facts dd { margin: 0; font-size: var(--ridrs-size-value); font-weight: 500; font-variant-numeric: tabular-nums; }
.db-note { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: ${COLORS.muted}; }
.db-warn { color: ${COLORS.amber}; }
.db-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.db-button { padding: 12px 26px; border: 0; border-radius: var(--ridrs-radius);
  background: var(--ridrs-surface-raised); box-shadow: var(--ridrs-edge); color: var(--ridrs-text);
  font: 500 var(--ridrs-size-body) var(--ridrs-font-text); cursor: pointer; }
.db-primary { background: ${COLORS.lime}; box-shadow: none; color: var(--ridrs-accent-text); font-weight: 600; }
.db-save-hero { min-width: min(280px, 100%); min-height: 54px; padding: 15px 40px; font-size: 18px; font-weight: 600; }
.db-delete { color: ${COLORS.red}; }
.db-delete-row { display: flex; justify-content: flex-start; padding-top: 8px; border-top: 1px solid ${COLORS.line}; }
.db-delete-small { padding: 6px 12px; background: transparent; box-shadow: none; color: ${COLORS.muted};
  font-size: 13px; }
.db-button:disabled { opacity: .5; cursor: default; }
.db-section { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px;
  border-radius: var(--ridrs-radius-lg); background: var(--ridrs-card); box-shadow: var(--ridrs-edge); }
.db-section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.db-section-info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.db-section-label { color: ${COLORS.cyan}; font: 500 var(--ridrs-size-label) var(--ridrs-font-mono);
  letter-spacing: .12em; text-transform: uppercase; }
.db-section-value { margin: 0; font-size: 17px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.db-options { list-style: none; display: flex; flex-direction: column; gap: 6px; margin: 4px 0 0; padding: 0;
  max-height: 240px; overflow-y: auto; }
.db-group { margin-top: 6px; color: ${COLORS.muted}; font: 600 11px var(--ridrs-font-mono);
  letter-spacing: .1em; text-transform: uppercase; }
.db-option { box-sizing: border-box; display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; width: 100%; padding: 10px 14px; border: 0; border-radius: var(--ridrs-radius);
  background: var(--ridrs-surface-raised); box-shadow: var(--ridrs-edge); color: var(--ridrs-text);
  font: 500 14px var(--ridrs-font-text); text-align: left; cursor: pointer; }
.db-option[aria-pressed="true"] { box-shadow: inset 0 0 0 2px ${COLORS.lime}; }
.db-option:disabled { opacity: .48; cursor: default; }
.db-option small { color: ${COLORS.muted}; font-size: 12px; white-space: nowrap; }
.db-confirm { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px;
  border-radius: var(--ridrs-radius-lg); background: var(--ridrs-card); box-shadow: var(--ridrs-edge); }
.db-confirm-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--ridrs-text); }
.db-more { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 14px; border-top: 1px solid ${COLORS.line}; }
.db-quiet { padding: 8px 18px; background: transparent; box-shadow: var(--ridrs-edge); color: ${COLORS.muted};
  font-size: 14px; }
.db-spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgb(255 255 255 / .2); border-top-color: ${COLORS.cyan}; animation: db-spin 1s linear infinite; }
@keyframes db-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .db-spin { animation: none; } }
`;

/** What became of the ride's recording: still being written, written, or lost. */
type Recording =
  | { readonly state: 'pending' }
  | { readonly state: 'saved'; readonly file: string; readonly distance?: number; readonly durationMs: number }
  | { readonly state: 'failed' };

/** `h:mm:ss`, or `m:ss` under an hour. */
function durationLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Local civil date `YYYY-MM-DD` for filtering planned calendar entries from today onwards. */
function localDate(now: number): string {
  const at = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
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

function ChoiceOption({
  chosen,
  disabled,
  detail,
  onPick,
  children,
}: {
  readonly chosen: boolean;
  readonly disabled?: boolean;
  readonly detail?: string;
  readonly onPick: () => void;
  readonly children: string;
}) {
  return (
    <li>
      <button
        type="button"
        className="db-option"
        aria-pressed={chosen}
        aria-label={children}
        aria-description={detail}
        disabled={disabled}
        onClick={onPick}
      >
        <span aria-hidden="true">{children}</span>
        {detail ? <small aria-hidden="true">{detail}</small> : null}
      </button>
    </li>
  );
}

function PickerList({
  id,
  label,
  children,
}: {
  readonly id: 'workout' | 'route';
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <ul className="db-options" data-picker={id} aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * The ride's session and everything the host reports about it. A component that mounts later
 * gets every ride of the run and the latest activity state, so values of an earlier ride are
 * filtered by the session.
 */
function useDebriefing(ctx: UiContext) {
  const [sessionId, setSessionId] = useState<string>();
  // The ride is not ended yet: Menu paused it and opened the activity menu over it (ADR 0108).
  const [open, setOpen] = useState(false);
  const [world, setWorld] = useState<RideWorld>();
  const [workout, setWorkout] = useState<RideWorkout>();
  const [rideFtp, setRideFtp] = useState<{ readonly sessionId: string; readonly ftp: number }>();
  const finished = useRef<string>(undefined);
  const [recordings, setRecordings] = useState<Readonly<Record<string, Recording>>>({});
  const [fits, setFits] = useState<Readonly<Record<string, string>>>({});
  const [uploads, setUploads] = useState<Readonly<Record<string, TrainingUpload>>>({});
  const [account, setAccount] = useState<TrainingAccount>();
  useLayoutEffect(() => {
    const subscriptions = [
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'finished') {
          finished.current = payload.sessionId;
          setSessionId(payload.sessionId);
          setWorld(payload.world);
          setWorkout(payload.workout);
          setOpen(false);
        } else if (payload.state === 'running' || payload.state === 'paused') {
          if (finished.current !== undefined && finished.current !== payload.sessionId) {
            // A ride started elsewhere (a second window) leads into the ride.
            ctx.navigate(ACTIVITY);
          } else {
            // The ride this menu was opened for, still going: Finish ride ends it.
            setSessionId(payload.sessionId);
            setWorld(payload.world);
            setWorkout(payload.workout);
            setOpen(true);
          }
        } else {
          ctx.navigate(MAIN);
        }
      }),
      ctx.events.subscribe(activityAthleteEvent, ({ payload }) => {
        if (payload.athlete.ftp !== undefined) {
          setRideFtp({ sessionId: payload.sessionId, ftp: payload.athlete.ftp });
        }
      }),
      ctx.state.watch(recordingRideState, ({ entries }) =>
        setRecordings(Object.fromEntries([...entries].flatMap(([key, ride]) => recordingOf(key, ride)))),
      ),
      ctx.state.watch(exportFitState, ({ entries }) =>
        setFits(Object.fromEntries([...entries].map(([key, fit]) => [key, fit.file]))),
      ),
      // A link to a ride of this device chooses its session (ADR 0079).
      ctx.state.watch(appLinkState, ({ entries }) => {
        const link = entries.get('activity');
        if (link) setSessionId(link.sessionId);
      }),
      ctx.state.watch(trainingUploadState, ({ entries }) => setUploads(Object.fromEntries(entries))),
      ctx.state.watch(trainingAccountState, ({ entries }) => setAccount(entries.get(SERVICE))),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [ctx]);
  return {
    sessionId,
    open,
    world,
    workout,
    rideFtp: sessionId && rideFtp?.sessionId === sessionId ? rideFtp.ftp : undefined,
    recording: (sessionId && recordings[sessionId]) || ({ state: 'pending' } as const),
    fit: sessionId ? fits[sessionId] : undefined,
    upload: sessionId ? uploads[sessionId] : undefined,
    account,
  };
}

function ActivityMenuBody({
  ctx,
  world,
  workout,
  rideFtp,
  onFinish,
}: {
  readonly ctx: UiContext;
  readonly world: RideWorld | undefined;
  readonly workout: RideWorkout | undefined;
  readonly rideFtp: number | undefined;
  readonly onFinish: () => void;
}) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const offers = useStateEntries(ctx, routeOfferState);
  const libraries = useStateEntries(ctx, trainingLibraryState);
  const calendars = useStateEntries(ctx, trainingCalendarState);
  const profiles = useStateEntries(ctx, athleteProfileState);
  const choices = useStateEntries(ctx, dataSourceState);
  const bin = useStateEntries(ctx, trashItemState);

  const root = useRef<HTMLElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'continue' | 'workout-trigger' | 'route-trigger' | 'pick-workout' | 'pick-route'>(
    undefined,
  );
  const [editing, setEditing] = useState<'workout' | 'route'>();
  const [problem, setProblem] = useState<Refusal>();

  const back = useRef(() => {});
  back.current = () => {
    if (editing) {
      focusNext.current = editing === 'workout' ? 'workout-trigger' : 'route-trigger';
      setEditing(undefined);
      setProblem(undefined);
      return;
    }
    ctx.leave();
  };
  useEffect(() => ctx.onBack(() => back.current()), [ctx]);

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = undefined;
    if (next === 'continue' || next === undefined) {
      if (!editing) continueButton.current?.focus();
      return;
    }
    const section = root.current;
    if (next === 'workout-trigger' || next === 'route-trigger') {
      section?.querySelector<HTMLElement>(`[data-focus="${next}"]`)?.focus();
      return;
    }
    const picker = next === 'pick-workout' ? 'workout' : 'route';
    const target =
      section?.querySelector<HTMLElement>(`[data-picker="${picker}"] [aria-pressed="true"]:not(:disabled)`) ??
      section?.querySelector<HTMLElement>(`[data-picker="${picker}"] button:not(:disabled)`);
    target?.focus();
  });

  const athlete = useMemo(
    () => resolveAthlete(profiles, choices, rideFtp),
    [profiles, choices, rideFtp],
  );
  const workoutChoices = useMemo(
    () => availableWorkouts(libraries, withoutBinned(calendars, bin), localDate(Date.now())),
    [libraries, calendars, bin],
  );
  const sortedOffers = useMemo(
    () => [...offers.values()].sort((a, b) => a.title.localeCompare(b.title)),
    [offers],
  );
  const activeOffer = useMemo(() => offerOf(world, offers.values()), [world, offers]);

  const onPickWorkout = (choice: RideWorkout | undefined) => {
    if (!choice) {
      setProblem(undefined);
      setEditing(undefined);
      focusNext.current = 'continue';
      ctx.events.publish(activityWorkoutRequestedEvent, {});
      return;
    }
    const resolved = resolveWorkoutForRide(choice, athlete);
    if (!resolved.ok) {
      setProblem(resolved.refusal);
      return;
    }
    setProblem(undefined);
    setEditing(undefined);
    focusNext.current = 'continue';
    ctx.events.publish(activityWorkoutRequestedEvent, { workout: resolved.ride });
  };

  const onPickWorld = (next: RideWorld | undefined) => {
    setEditing(undefined);
    focusNext.current = 'continue';
    ctx.events.publish(activityWorldRequestedEvent, next ? { world: next } : {});
  };

  const workoutName = workout?.workout.name ?? text.noWorkout;
  const routeName = world ? (activeOffer?.title ?? world.route ?? text.freeRide) : text.freeRide;

  return (
    <main ref={root} className="db-screen" data-testid="debriefing">
      <style>{CSS}</style>
      <h1>{text.menuTitle}</h1>

      <div className="db-actions">
        <button
          ref={continueButton}
          type="button"
          className="db-button db-primary"
          onClick={() => ctx.leave()}
        >
          {text.continueRide}
        </button>
        <button type="button" className="db-button" onClick={onFinish}>
          {text.finishRide}
        </button>
      </div>

      <section className="db-section" aria-label={text.workout} data-testid="activity-menu-workout">
        <div className="db-section-head">
          <div className="db-section-info">
            <span className="db-section-label">{text.workout}</span>
            <p className="db-section-value">{workoutName}</p>
          </div>
          <button
            type="button"
            className="db-button"
            data-focus="workout-trigger"
            onClick={() => {
              const next = editing === 'workout' ? undefined : 'workout';
              setEditing(next);
              setProblem(undefined);
              focusNext.current = next ? 'pick-workout' : 'workout-trigger';
            }}
          >
            {workout ? text.changeWorkout : text.loadWorkout}
          </button>
        </div>
        {problem ? (
          <p className="db-note db-warn" role="alert">
            {text.refusal[problem]}
          </p>
        ) : null}
        {editing === 'workout' ? (
          <PickerList id="workout" label={text.workout}>
            <ChoiceOption chosen={workout === undefined} onPick={() => onPickWorkout(undefined)}>
              {text.noWorkout}
            </ChoiceOption>
            {workoutChoices.planned.length > 0 ? (
              <li className="db-group" aria-hidden="true">
                {text.planned}
              </li>
            ) : null}
            {workoutChoices.planned.map((each) => (
              <ChoiceOption
                key={each.key}
                chosen={sameRideWorkout(workout, each.ride)}
                detail={each.date}
                onPick={() => onPickWorkout(each.ride)}
              >
                {each.name}
              </ChoiceOption>
            ))}
            {workoutChoices.library.length > 0 ? (
              <li className="db-group" aria-hidden="true">
                {text.library}
              </li>
            ) : null}
            {workoutChoices.library.map((each) => (
              <ChoiceOption
                key={each.key}
                chosen={sameRideWorkout(workout, each.ride)}
                onPick={() => onPickWorkout(each.ride)}
              >
                {each.name}
              </ChoiceOption>
            ))}
          </PickerList>
        ) : null}
      </section>

      <section className="db-section" aria-label={text.route} data-testid="activity-menu-route">
        <div className="db-section-head">
          <div className="db-section-info">
            <span className="db-section-label">{text.route}</span>
            <p className="db-section-value">{routeName}</p>
          </div>
          <button
            type="button"
            className="db-button"
            data-focus="route-trigger"
            onClick={() => {
              const next = editing === 'route' ? undefined : 'route';
              setEditing(next);
              focusNext.current = next ? 'pick-route' : 'route-trigger';
            }}
          >
            {text.changeRoute}
          </button>
        </div>
        {editing === 'route' ? (
          <PickerList id="route" label={text.route}>
            <ChoiceOption chosen={world === undefined} onPick={() => onPickWorld(undefined)}>
              {text.freeRide}
            </ChoiceOption>
            {sortedOffers.map((each) => {
              const ready = each.availability.state === 'ready';
              const km = `${localizeNumber((each.distance / 1000).toFixed(1), language)} km`;
              return (
                <ChoiceOption
                  key={each.id}
                  chosen={sameWorld(world, each.world)}
                  disabled={!ready}
                  detail={ready ? km : `${km} · ${text.notDownloaded}`}
                  onPick={() => onPickWorld(each.world)}
                >
                  {each.title}
                </ChoiceOption>
              );
            })}
          </PickerList>
        ) : null}
      </section>

      {ctx.hasScreen(SETTINGS) || ctx.hasScreen(DEVICES) ? (
        <nav className="db-more" aria-label={text.more}>
          {ctx.hasScreen(DEVICES) ? (
            <button type="button" className="db-button db-quiet" onClick={() => ctx.navigate(DEVICES)}>
              {text.devices}
            </button>
          ) : null}
          {ctx.hasScreen(SETTINGS) ? (
            <button type="button" className="db-button db-quiet" onClick={() => ctx.navigate(SETTINGS)}>
              {text.settings}
            </button>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}

function DebriefingView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const { sessionId, open, world, workout, rideFtp, recording, fit, upload, account } = useDebriefing(ctx);

  const save = useRef<HTMLButtonElement>(null);
  const noButton = useRef<HTMLButtonElement>(null);

  // How often Save (or Try again) was pressed: each attempt uploads once connected and FIT is written.
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(0);
  const saving = attempt > 0;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refused, setRefused] = useState<string>();
  const connected = account?.state === 'connected';
  const connecting = account?.state === 'connecting';

  // Ends the ride once, when Finish ride in the activity menu transitions to Ride finished (ADR 0108).
  const [ended, setEnded] = useState(false);
  const going = open && !ended;

  const endRide = () => {
    if (open && !ended) {
      setEnded(true);
      ctx.events.publish(activityFinishRequestedEvent, {});
    }
  };

  // Once the ride is ended, Back cancels the delete question or offers Save.
  const back = useRef(() => {});
  back.current = () => {
    if (confirmDelete) {
      setConfirmDelete(false);
    } else {
      save.current?.focus();
    }
  };
  useEffect(() => (going ? undefined : ctx.onBack(() => back.current())), [ctx, going]);

  useEffect(() => {
    if (connected && attempt > requested.current && fit && sessionId) {
      requested.current = attempt;
      ctx
        .call(trainingUploadService, { key: SERVICE, sessionId, file: fit })
        .catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)));
    }
  }, [ctx, connected, attempt, fit, sessionId]);

  useEffect(() => {
    if (saving && upload?.state === 'uploaded') {
      ctx.navigate(MAIN);
    }
  }, [ctx, saving, upload?.state]);

  const decided = recording.state !== 'pending';
  const waitingForAccount = saving && connecting;
  const uploading =
    (saving && refused === undefined && upload?.state !== 'failed' && connected) || waitingForAccount;
  const failed = !waitingForAccount && saving && upload?.state === 'failed' ? upload : undefined;
  const tryAgain = failed !== undefined || refused !== undefined;
  const reconnect = failed !== undefined && !connected && !connecting;
  const saveDisabled = uploading || reconnect;

  // Focus in Ride finished: No when confirming Delete, else Save once it can be pressed.
  useEffect(() => {
    if (going) return;
    if (confirmDelete) {
      noButton.current?.focus();
    } else if (!saveDisabled) {
      save.current?.focus();
    }
  }, [going, saveDisabled, confirmDelete]);

  const onSave = () => {
    endRide();
    if ((!connected && !connecting) || recording.state === 'failed') {
      ctx.navigate(MAIN);
      return;
    }
    setRefused(undefined);
    setAttempt((count) => count + 1);
  };

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
  const onDelete = () => {
    endRide();
    setDeleting(true);
  };

  if (going) {
    return (
      <ActivityMenuBody
        ctx={ctx}
        world={world}
        workout={workout}
        rideFtp={rideFtp}
        onFinish={endRide}
      />
    );
  }

  return (
    <main className="db-screen" data-testid="debriefing">
      <style>{CSS}</style>
      <h1>{text.finished}</h1>
      {recording.state === 'saved' ? (
        <dl className="db-facts">
          <div>
            <dt>{text.distance}</dt>
            <dd data-testid="debriefing-distance">
              {recording.distance === undefined
                ? '–'
                : text.km(localizeNumber((recording.distance / 1000).toFixed(2), language))}
            </dd>
          </div>
          <div>
            <dt>{text.time}</dt>
            <dd data-testid="debriefing-duration">{durationLabel(recording.durationMs)}</dd>
          </div>
        </dl>
      ) : null}
      <div role="status" data-testid="debriefing-status">
        {recording.state === 'failed' ? (
          <p className="db-note db-warn">{text.notRecorded}</p>
        ) : uploading ? (
          <p className="db-note">
            <span className="db-spin" aria-hidden="true" />
            {text.uploading}
          </p>
        ) : refused !== undefined ? (
          <p className="db-note db-warn">
            {refused} {text.kept}
          </p>
        ) : failed ? (
          <p className="db-note db-warn">
            {failed.reason ? text.failures[failed.reason] : text.uploadFailed} {text.kept}
          </p>
        ) : connected ? (
          <p className="db-note">{text.saveUploads(account?.athleteName)}</p>
        ) : (
          <p className="db-note">{text.saveKeeps}</p>
        )}
      </div>
      {confirmDelete ? (
        <div className="db-confirm" role="group" aria-label={text.deleteQuestion}>
          <p className="db-confirm-title">{text.deleteQuestion}</p>
          <p className="db-note db-warn">{text.deleteWarning}</p>
          <div className="db-actions">
            <button type="button" className="db-button db-delete" onClick={onDelete}>
              {text.yes}
            </button>
            <button
              ref={noButton}
              type="button"
              className="db-button"
              onClick={() => setConfirmDelete(false)}
            >
              {text.no}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="db-actions">
            <button
              ref={save}
              type="button"
              className="db-button db-primary db-save-hero"
              disabled={saveDisabled}
              onClick={onSave}
            >
              {tryAgain ? text.tryAgain : text.save}
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
                {failed?.reason === 'token-rejected' ? text.reconnect : text.connect}
              </button>
            ) : null}
            {tryAgain ? (
              <button type="button" className="db-button" onClick={() => ctx.navigate(MAIN)}>
                {text.withoutUpload}
              </button>
            ) : null}
          </div>
          <div className="db-delete-row">
            <button
              type="button"
              className="db-button db-delete db-delete-small"
              disabled={uploading || deleting}
              onClick={() => setConfirmDelete(true)}
            >
              {text.delete}
            </button>
          </div>
        </>
      )}
    </main>
  );
}

export const DebriefingScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<DebriefingView ctx={ctx} />);
  return () => root.unmount();
};
