// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStateChangedEvent,
  type PlannedWorkout,
  type TrainingAccount,
  type TrainingPlan,
  trainingAccountChangedEvent,
  trainingConnectRequestedEvent,
  trainingDisconnectRequestedEvent,
  trainingPlanChangedEvent,
  trainingRefreshRequestedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
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
import { COLORS, TrainingStyles } from './theme.tsx';

/** The screens this plugin moves between. */
const MAIN = 'main';
const DETAILS = 'training-workout';

/**
 * The latest account state and plan; the bridge replays both to every component that mounts
 * later. Layout effects take the replayed values before the first paint, so nothing flashes.
 */
function useTraining(ctx: UiContext): {
  readonly account?: TrainingAccount;
  readonly plan?: TrainingPlan;
} {
  const [account, setAccount] = useState<TrainingAccount>();
  const [plan, setPlan] = useState<TrainingPlan>();
  useLayoutEffect(() => {
    const subscriptions = [
      ctx.events.subscribe(trainingAccountChangedEvent, ({ payload }) => setAccount(payload)),
      ctx.events.subscribe(trainingPlanChangedEvent, ({ payload }) => setPlan(payload)),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [ctx]);
  return { account, plan };
}

/** "Today" is the rider's calendar day; the UI reads the wall clock, never drives anything with it. */
const nextWorkout = (plan: TrainingPlan | undefined): PlannedWorkout | undefined =>
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

function NextWorkoutView({ ctx }: { readonly ctx: UiContext }) {
  const { account, plan } = useTraining(ctx);
  if (!account) {
    return null;
  }

  if (account.state === 'connecting') {
    return (
      <section className="rt-panel" data-testid="training-account">
        <TrainingStyles />
        <span className="rt-caption">
          <span className="rt-spin" aria-hidden="true" />
          Connecting to intervals.icu…
        </span>
        <span className="rt-hint">Finish the sign-in in your browser.</span>
      </section>
    );
  }

  if (account.state !== 'connected') {
    const message = accountMessage(account);
    const label =
      account.reason === 'token-rejected' ? 'Reconnect intervals.icu' : 'Connect intervals.icu';
    return (
      <section className="rt-panel" data-testid="training-account">
        <TrainingStyles />
        {message ? <span className="rt-hint rt-warn">{message}</span> : null}
        <button
          type="button"
          className="rt-button"
          onClick={() => ctx.events.publish(trainingConnectRequestedEvent, {})}
        >
          {label}
        </button>
        <span className="rt-hint">Your planned workouts on the main screen.</span>
      </section>
    );
  }

  const workout = nextWorkout(plan);
  const caption = [
    account.athleteName ? `Connected as ${account.athleteName}` : 'Connected',
    plan?.offline ? 'Offline' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="rt-panel" data-testid="training-account">
      <TrainingStyles />
      <span className="rt-caption">intervals.icu · {caption}</span>
      <button
        type="button"
        className="rt-card"
        data-testid="next-workout"
        aria-label={
          workout
            ? `Next workout: ${workout.name}, ${dayLabel(workout.date, Date.now())}`
            : plan
              ? 'No workout planned'
              : 'Loading your plan'
        }
        onClick={() => ctx.navigate(DETAILS)}
      >
        {workout ? (
          <>
            <span className="rt-day" data-testid="next-workout-day">
              {dayLabel(workout.date, Date.now())}
            </span>
            <span className="rt-name" data-testid="next-workout-name">
              {workout.name}
            </span>
            <span className="rt-facts">
              {workout.durationSeconds !== undefined ? (
                <span data-testid="next-workout-duration">{durationLabel(workout.durationSeconds)}</span>
              ) : null}
              {workout.trainingLoad !== undefined ? (
                <span data-testid="next-workout-load">Load {Math.round(workout.trainingLoad)}</span>
              ) : null}
            </span>
            <PowerProfile workout={workout} />
          </>
        ) : (
          <span className="rt-name rt-muted">{plan ? 'No workout planned' : 'Loading your plan…'}</span>
        )}
      </button>
    </section>
  );
}

function StepRows({ workout }: { readonly workout: PlannedWorkout }) {
  const rows: Array<{ step: string; duration: string; target: string; inner: boolean }> = [];
  for (const step of workout.steps) {
    if (step.kind === 'repeat') {
      rows.push({ step: `${step.reps}×`, duration: '', target: '', inner: false });
      for (const inner of unrolled(step.steps)) {
        rows.push({
          step: stepName(inner),
          duration: durationLabel(inner.durationSeconds),
          target: inner.power ? powerLabel(inner.power) : '',
          inner: true,
        });
      }
    } else {
      rows.push({
        step: stepName(step),
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
  const { account, plan } = useTraining(ctx);
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
          intervals.icu{account?.athleteName ? ` · ${account.athleteName}` : ''}
          {plan?.offline ? ' · Offline' : ''}
        </span>
        <h1>{workout ? workout.name : 'No workout planned'}</h1>
        {workout ? (
          <span className="rt-facts">
            <span>{dayLabel(workout.date, Date.now())}</span>
            {workout.durationSeconds !== undefined ? <span>{durationLabel(workout.durationSeconds)}</span> : null}
            {workout.trainingLoad !== undefined ? <span>Load {Math.round(workout.trainingLoad)}</span> : null}
          </span>
        ) : (
          <span className="rt-hint">Nothing planned for the next 14 days.</span>
        )}
      </header>
      {athlete ? (
        <dl className="rt-athlete">
          <dt>FTP</dt>
          <dd data-testid="workout-ftp">{athlete.ftp !== undefined ? `${Math.round(athlete.ftp)} W` : '–'}</dd>
          <dt>Weight</dt>
          <dd data-testid="workout-weight">{athlete.weight !== undefined ? `${athlete.weight} kg` : '–'}</dd>
        </dl>
      ) : null}
      {workout?.description ? <p className="rt-description">{workout.description}</p> : null}
      {workout && workout.steps.length > 0 ? <StepRows workout={workout} /> : null}
      <footer>
        <button
          type="button"
          className="rt-button"
          onClick={() => ctx.events.publish(trainingRefreshRequestedEvent, {})}
        >
          Refresh
        </button>
        <button
          type="button"
          className="rt-button rt-quiet"
          onClick={() => {
            ctx.events.publish(trainingDisconnectRequestedEvent, {});
            ctx.navigate(MAIN);
          }}
        >
          Disconnect intervals.icu
        </button>
      </footer>
    </main>
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
