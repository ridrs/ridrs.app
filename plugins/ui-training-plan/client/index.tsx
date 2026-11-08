// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type AthleteProfile,
  athleteProfileState,
  type DataSource,
  dataSourceState,
  type PlannedWorkout,
  type ServiceDefinition,
  type TrainingAccount,
  type TrainingCalendar,
  trainingAccountState,
  trainingCalendarState,
  trainingConnectService,
  trainingDisconnectService,
  trainingRefreshService,
} from '@ridrs/contracts';
import { localizeNumber, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  accountMessage,
  dayLabel,
  durationLabel,
  powerLabel,
  stepName,
  unrolled,
} from './format.ts';
import { type Messages, messages } from './i18n/index.ts';
import { COLORS, TrainingStyles } from './theme.tsx';

/** The screens this plugin moves between. */
const MAIN = 'main';
const DETAILS = 'training-workout';

/** The service whose account and plan this plugin shows: its key in the app state. */
const SERVICE = 'intervals.icu';

/** The plan as the card and the details show it: the calendar of the service and its athlete. */
interface Plan {
  /** True when the service could not be reached and its last load stands in. */
  readonly offline: boolean;
  readonly workouts: PlannedWorkout[];
  readonly athlete?: AthleteProfile;
}

/**
 * The account, the athlete profile and the calendar of the service, from the app state
 * `training.account`, `athlete.profile` and `training.calendar` (ADR 0068, 0075): every component
 * that mounts gets them as they are now, then their changes. The plan is there once the calendar
 * has data.
 */
function useTraining(ctx: UiContext): {
  readonly account?: TrainingAccount;
  readonly plan?: Plan;
  /** The provider of the calendar in use: the chosen one, else intervals.icu. */
  readonly source: string;
} {
  const [account, setAccount] = useState<TrainingAccount>();
  const [calendars, setCalendars] = useState<ReadonlyMap<string, DataSource<TrainingCalendar>>>(new Map());
  const [profiles, setProfiles] = useState<ReadonlyMap<string, DataSource<AthleteProfile>>>(new Map());
  const [chosen, setChosen] = useState<string>();
  useLayoutEffect(() => {
    const subscriptions = [
      ctx.state.watch(trainingAccountState, ({ entries }) => setAccount(entries.get(SERVICE))),
      ctx.state.watch(trainingCalendarState, ({ entries }) => setCalendars(new Map(entries))),
      ctx.state.watch(athleteProfileState, ({ entries }) => setProfiles(new Map(entries))),
      ctx.state.watch(dataSourceState, ({ entries }) => setChosen(entries.get('training.calendar')?.provider)),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [ctx]);
  // The chosen source; where it offers no calendar at all, the service this plugin is for.
  const source = chosen !== undefined && calendars.has(chosen) ? chosen : SERVICE;
  const calendar = calendars.get(source);
  const profile = profiles.get(source);
  const plan = calendar?.data
    ? {
        offline: calendar.status === 'offline',
        workouts: calendar.data.workouts,
        ...(profile?.data ? { athlete: profile.data } : {}),
      }
    : undefined;
  return { account, plan, source };
}

/** Calls a service of the account; the planner answers once the work started, its state follows. */
function callAccount(ctx: UiContext, service: ServiceDefinition<{ readonly key: string }, unknown>): void {
  ctx.call(service, { key: SERVICE }).catch((error: unknown) =>
    ctx.logger.warn(`intervals.icu: "${service.id}" was refused`, error),
  );
}

/** "Today" is the rider's calendar day; the UI reads the wall clock, never drives anything with it. */
const nextWorkout = (plan: Plan | undefined): PlannedWorkout | undefined =>
  plan?.workouts[0];

function PowerProfile({ workout }: { readonly workout: PlannedWorkout }) {
  const intervals = unrolled(workout.steps);
  if (intervals.length === 0) {
    return null;
  }
  const top = Math.max(120, ...intervals.map((step) => Math.max(step.power?.high ?? 0, step.power?.low ?? 0)));
  return (
    <div className="rt-profile" data-testid="next-workout-profile" aria-hidden="true">
      {intervals.map((step, index) => {
        const percent = step.power ? (step.power.low + step.power.high) / 2 : 0;
        return (
          <i
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars are positional and never reorder.
            key={index}
            data-bar
            style={{
              flexGrow: Math.max(step.durationSeconds, 1),
              height: `${Math.max(8, (percent / top) * 100)}%`,
              background: percent >= 105 ? COLORS.red : percent >= 88 ? COLORS.amber : COLORS.cyan,
            }}
          />
        );
      })}
    </div>
  );
}

/** After a rejected token the rider connects again; else for the first time. */
const connectLabel = (account: TrainingAccount, text: Messages): string =>
  account.reason === 'token-rejected' ? text.reconnect : text.connect;

/** While the sign-in runs in the system browser. */
function Connecting({ testId, text }: { readonly testId: string; readonly text: Messages }) {
  return (
    <section className="rt-panel" data-testid={testId}>
      <TrainingStyles />
      <span className="rt-caption">
        <span className="rt-spin" aria-hidden="true" />
        {text.connecting}
      </span>
      <span className="rt-hint">{text.finishSignIn}</span>
    </section>
  );
}

function NextWorkoutView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const { account, plan, source } = useTraining(ctx);
  if (source !== SERVICE) {
    // The calendar of ridrs on this device has no account to connect.
    return <NextWorkoutCard ctx={ctx} text={text} plan={plan} caption={text.thisDevice} />;
  }
  if (!account) {
    return null;
  }

  if (account.state === 'connecting') {
    return <Connecting testId="training-account" text={text} />;
  }

  if (account.state !== 'connected') {
    const message = accountMessage(account, text);
    return (
      <section className="rt-panel" data-testid="training-account">
        <TrainingStyles />
        {message ? <span className="rt-hint rt-warn">{message}</span> : null}
        <button
          type="button"
          className="rt-button"
          onClick={() => callAccount(ctx, trainingConnectService)}
        >
          {connectLabel(account, text)}
        </button>
        <span className="rt-hint">{text.onMainScreen}</span>
      </section>
    );
  }

  const caption = [
    text.connectedAs(account.athleteName),
    plan?.offline ? text.offline : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <NextWorkoutCard ctx={ctx} text={text} plan={plan} caption={`intervals.icu · ${caption}`} />
  );
}

/** The card of the next workout, with the source it comes from under it. */
function NextWorkoutCard({
  ctx,
  text,
  plan,
  caption,
}: {
  readonly ctx: UiContext;
  readonly text: Messages;
  readonly plan: Plan | undefined;
  readonly caption: string;
}) {
  const workout = nextWorkout(plan);
  return (
    <section className="rt-panel" data-testid="training-account">
      <TrainingStyles />
      <button
        type="button"
        className="rt-card"
        data-testid="next-workout"
        aria-label={
          workout
            ? text.nextWorkoutOn(workout.name, dayLabel(workout.date, Date.now(), text))
            : plan
              ? text.nonePlanned
              : text.loading
        }
        onClick={() => ctx.navigate(DETAILS)}
      >
        <span className="rt-classifier">{text.nextWorkout}</span>
        {workout ? (
          <>
            <span className="rt-name" data-testid="next-workout-name">
              {workout.name}
            </span>
            <span className="rt-facts">
              <span data-testid="next-workout-day">{dayLabel(workout.date, Date.now(), text)}</span>
              {workout.durationSeconds !== undefined ? (
                <span data-testid="next-workout-duration">{durationLabel(workout.durationSeconds)}</span>
              ) : null}
              {workout.trainingLoad !== undefined ? (
                <span data-testid="next-workout-load">{text.load(Math.round(workout.trainingLoad))}</span>
              ) : null}
            </span>
            <PowerProfile workout={workout} />
          </>
        ) : (
          <span className="rt-name rt-muted">{plan ? text.nonePlanned : text.loadingDots}</span>
        )}
      </button>
      <span className="rt-caption">{caption}</span>
    </section>
  );
}

function StepRows({ workout, text }: { readonly workout: PlannedWorkout; readonly text: Messages }) {
  const rows: Array<{ step: string; duration: string; target: string; inner: boolean }> = [];
  for (const step of workout.steps) {
    if (step.kind === 'repeat') {
      rows.push({ step: `${step.reps}×`, duration: '', target: '', inner: false });
      for (const inner of unrolled(step.steps)) {
        rows.push({
          step: stepName(inner, text),
          duration: durationLabel(inner.durationSeconds),
          target: inner.power ? powerLabel(inner.power) : '',
          inner: true,
        });
      }
    } else {
      rows.push({
        step: stepName(step, text),
        duration: durationLabel(step.durationSeconds),
        target: step.power ? powerLabel(step.power) : '',
        inner: false,
      });
    }
  }
  return (
    <ol className="rt-steps">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows are positional and never reorder.
        <li key={index} data-testid="workout-step" className={row.inner ? 'rt-inner' : undefined}>
          <span data-field="step">{row.step}</span>
          <span data-field="duration">{row.duration}</span>
          <span data-field="target">{row.target}</span>
        </li>
      ))}
    </ol>
  );
}

function WorkoutDetailsView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const { account, plan, source } = useTraining(ctx);
  useEffect(() => ctx.onBack(() => ctx.navigate(MAIN)), [ctx]);
  // A ride started elsewhere (a second window) leads into the ride, as on the main screen.
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running') {
          ctx.navigate('activity');
        }
      }),
    [ctx],
  );

  const workout = nextWorkout(plan);
  const athlete = plan?.athlete;
  return (
    <main className="rt-details">
      <TrainingStyles />
      <header>
        <span className="rt-caption">
          {source === SERVICE ? 'intervals.icu' : text.thisDevice}
          {source === SERVICE && account?.athleteName ? ` · ${account.athleteName}` : ''}
          {plan?.offline ? ` · ${text.offline}` : ''}
        </span>
        <h1>{workout ? workout.name : text.nonePlanned}</h1>
        {workout ? (
          <span className="rt-facts">
            <span>{dayLabel(workout.date, Date.now(), text)}</span>
            {workout.durationSeconds !== undefined ? <span>{durationLabel(workout.durationSeconds)}</span> : null}
            {workout.trainingLoad !== undefined ? <span>{text.load(Math.round(workout.trainingLoad))}</span> : null}
          </span>
        ) : (
          <span className="rt-hint">{text.nothingSoon}</span>
        )}
      </header>
      {athlete ? (
        <dl className="rt-athlete">
          <dt>{text.ftp}</dt>
          <dd data-testid="workout-ftp">{athlete.ftp !== undefined ? `${Math.round(athlete.ftp)} W` : '–'}</dd>
          <dt>{text.weight}</dt>
          <dd data-testid="workout-weight">
            {athlete.weight !== undefined ? `${localizeNumber(String(athlete.weight), language)} kg` : '–'}
          </dd>
        </dl>
      ) : null}
      {workout?.description ? <p className="rt-description">{workout.description}</p> : null}
      {workout && workout.steps.length > 0 ? <StepRows workout={workout} text={text} /> : null}
      <footer>
        <button
          type="button"
          className="rt-button"
          onClick={() => callAccount(ctx, trainingRefreshService)}
        >
          {text.refresh}
        </button>
      </footer>
    </main>
  );
}

/** The account in the Me area: its state, Connect or Reconnect, and Disconnect. */
function IntervalsConnectionView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const { account } = useTraining(ctx);
  if (!account) {
    return null;
  }

  if (account.state === 'connecting') {
    return <Connecting testId="intervals-connection" text={text} />;
  }

  if (account.state !== 'connected') {
    const message = accountMessage(account, text);
    return (
      <section className="rt-panel" data-testid="intervals-connection">
        <TrainingStyles />
        <span className="rt-caption">intervals.icu · {text.notConnected}</span>
        {message ? <span className="rt-hint rt-warn">{message}</span> : null}
        <button
          type="button"
          className="rt-button"
          onClick={() => callAccount(ctx, trainingConnectService)}
        >
          {connectLabel(account, text)}
        </button>
      </section>
    );
  }

  return (
    <section className="rt-panel" data-testid="intervals-connection">
      <TrainingStyles />
      <span className="rt-caption">
        intervals.icu · {text.connectedAs(account.athleteName)}
      </span>
      <span className="rt-hint">{text.comesFromHere}</span>
      <button
        type="button"
        className="rt-button rt-quiet"
        onClick={() => callAccount(ctx, trainingDisconnectService)}
      >
        {text.disconnect}
      </button>
    </section>
  );
}

export const NextWorkout: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<NextWorkoutView ctx={ctx} />);
  return () => root.unmount();
};

export const WorkoutDetails: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<WorkoutDetailsView ctx={ctx} />);
  return () => root.unmount();
};

export const IntervalsConnection: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<IntervalsConnectionView ctx={ctx} />);
  return () => root.unmount();
};
