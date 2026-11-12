// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityStartRequestedEvent,
  type AthleteProfile,
  athleteProfileState,
  type Bicycle,
  type DataSource,
  type DataSourceChoice,
  dataSourceState,
  type DeviceStatus,
  deviceStatusState,
  equipmentBicycleChangedEvent,
  mergeDeviceStatuses,
  type RideBriefing,
  type RideWorkout,
  type RouteOffer,
  rideBriefingSetService,
  rideBriefingState,
  routeFetchService,
  routeOfferState,
  routeProfileCapability,
  type StateDefinition,
  trainingCalendarState,
  trainingLibraryState,
  type UiCapabilityInput,
  type Workout,
  workoutChartCapability,
} from '@ridrs/contracts';
import { localizeNumber, type UiCapabilityHandle, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { defaultPowerZones, type WorkoutAthlete, type WorkoutMetrics, workoutMetrics } from '@ridrs/workout';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type Answers,
  type Calendar,
  chosenAthlete,
  type Fixed,
  type Found,
  findWorkout,
  type Library,
  lengthNote,
  offerOf,
  rememberedChoice,
  resolveForRide,
  startingAnswers,
  stillLoading,
  type World,
  type WorkoutOption,
  type WorkoutPick,
  workoutOptions,
} from './choice.ts';
import { type Messages, messages } from './i18n/index.ts';
import { BriefingStyles } from './theme.tsx';

/** The screens the briefing opens: pairing and the garage are dialogs of the main screen (ADR 0071). */
const SETUP = 'setup';
const GARAGE = 'garage';

/** Every entry of an app state topic once it has delivered, and again when it changes; `undefined` before. */
function useWatched<T>(ctx: UiContext, topic: StateDefinition<T>): ReadonlyMap<string, T> | undefined {
  const [entries, setEntries] = useState<ReadonlyMap<string, T>>();
  useEffect(() => ctx.state.watch(topic, (view) => setEntries(view.entries)), [ctx, topic]);
  return entries;
}

/** "1 h 3 min", "45 min", "30 s". */
function durationText(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return total % 60 > 0 ? `${m} min ${total % 60} s` : `${m} min`;
  return `${total} s`;
}

/** The rider's local date of `now`, `YYYY-MM-DD`: the UI reads the wall clock and drives nothing with it. */
function localDate(now: number): string {
  const at = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

const sameWorld = (a: World | null | undefined, b: World | null | undefined) =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.landscape === b.landscape && a.route === b.route);

/** Whether two picks name the same workout. */
function samePick(a: WorkoutPick | undefined, b: WorkoutPick): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'none') return true;
  if (a.kind === 'library' && b.kind === 'library') return a.from === b.from && a.workoutId === b.workoutId;
  return a.kind === 'planned' && b.kind === 'planned' && a.from === b.from && a.id === b.id;
}

/** A choice among options: one button each, the chosen one marked; the arrows move through them. */
function Picker({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <ul className="br-options" data-picker={id} aria-label={label}>
      {children}
    </ul>
  );
}

function Option({
  chosen,
  onPick,
  children,
  detail,
}: {
  readonly chosen: boolean;
  readonly onPick: () => void;
  readonly children: string;
  readonly detail?: string;
}) {
  return (
    <li>
      <button
        type="button"
        className="br-option"
        aria-pressed={chosen}
        aria-label={children}
        aria-description={detail}
        onClick={onPick}
      >
        <span aria-hidden="true">{children}</span>
        {detail ? <small aria-hidden="true">{detail}</small> : null}
      </button>
    </li>
  );
}

type ChartInput = UiCapabilityInput<typeof workoutChartCapability>;

/**
 * The workout chart through `ui.workout-chart` (ADR 0083), variant `full`: the arrows step through
 * its steps. Its container belongs to the shell while the provider draws; the fallback is a
 * sibling, shown while there is no provider.
 */
function ChartPreview({
  ctx,
  workout,
  athlete,
  fallback,
  label,
}: {
  readonly ctx: UiContext;
  readonly workout: Workout;
  readonly athlete: WorkoutAthlete;
  readonly fallback: string;
  readonly label: string;
}) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<UiCapabilityHandle<typeof workoutChartCapability>>(undefined);
  const [selected, setSelected] = useState<string>();
  const [available, setAvailable] = useState(false);
  const input = useMemo<ChartInput>(
    () => ({ workout, athlete, variant: 'full', ...(selected === undefined ? {} : { selectedStep: selected }) }),
    [workout, athlete, selected],
  );
  const drawn = useRef(input);
  useEffect(() => {
    const element = place.current;
    if (!element) return undefined;
    const chart = ctx.render(workoutChartCapability, element, drawn.current);
    handle.current = chart;
    const stops = [chart.onAvailability(setAvailable), chart.on('step-focused', ({ stepId }) => setSelected(stepId))];
    return () => {
      for (const stop of stops) stop();
      chart.release();
      handle.current = undefined;
    };
  }, [ctx]);
  useEffect(() => {
    if (drawn.current === input) return;
    drawn.current = input;
    handle.current?.update(input);
  }, [input]);
  return (
    <section className="br-section" aria-label={label}>
      <div ref={place} data-testid="briefing-workout-chart" data-available={String(available)} />
      {available ? null : (
        <p className="br-fallback" data-testid="briefing-workout-chart-fallback">
          {fallback}
        </p>
      )}
    </section>
  );
}

/** The route's profile through `ui.route-profile` (ADR 0083), variant `full`; without a provider, nothing. */
function RoutePreview({ ctx, offer, label }: { readonly ctx: UiContext; readonly offer: RouteOffer; readonly label: string }) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<UiCapabilityHandle<typeof routeProfileCapability>>(undefined);
  const drawn = useRef({ route: offer.id, variant: 'full' as const });
  useEffect(() => {
    const element = place.current;
    if (!element) return undefined;
    const profile = ctx.render(routeProfileCapability, element, drawn.current);
    handle.current = profile;
    return () => {
      profile.release();
      handle.current = undefined;
    };
  }, [ctx]);
  useEffect(() => {
    if (drawn.current.route === offer.id) return;
    drawn.current = { route: offer.id, variant: 'full' };
    handle.current?.update(drawn.current);
  }, [offer.id]);
  return (
    <section className="br-section" aria-label={label}>
      <div ref={place} data-testid="briefing-route-profile" />
    </section>
  );
}

/** What the rider is told of the numbers: duration, distance, TSS and the time per power zone. */
function Summary({
  text,
  language,
  metrics,
  offer,
  athlete,
}: {
  readonly text: Messages;
  readonly language: 'en' | 'de';
  readonly metrics: WorkoutMetrics | undefined;
  readonly offer: RouteOffer | undefined;
  readonly athlete: WorkoutAthlete;
}) {
  const pairs: [string, string][] = [];
  if (metrics) pairs.push([text.duration, durationText(metrics.durationSeconds)]);
  else if (offer?.duration !== undefined) pairs.push([text.duration, durationText(offer.duration)]);
  if (offer) {
    pairs.push([text.distance, `${localizeNumber((offer.distance / 1000).toFixed(1), language)} km`]);
  }
  if (metrics?.trainingLoad !== undefined) pairs.push([text.trainingLoad, String(Math.round(metrics.trainingLoad))]);
  const zones = athlete.powerZones ?? defaultPowerZones();
  if (pairs.length === 0 && !metrics) return null;
  return (
    <section className="br-section" aria-label={text.summary} data-testid="briefing-summary-section">
      <h2>{text.summary}</h2>
      <dl className="br-pairs" data-testid="briefing-summary">
        {pairs.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {metrics ? (
        metrics.timeInZones ? (
          <dl className="br-zones" data-testid="briefing-zones" aria-label={text.timeInZones}>
            {zones.map((zone, index) => (
              <div key={`${zone.name ?? ''}-${zone.upTo ?? 'open'}`}>
                <dt>{zone.name ? `Z${index + 1} ${zone.name}` : `Z${index + 1}`}</dt>
                <dd>
                  {(metrics.timeInZones?.[index] ?? 0) > 0 ? durationText(metrics.timeInZones?.[index] ?? 0) : '–'}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="br-hint">{text.zonesNeedFtp}</p>
        )
      ) : null}
    </section>
  );
}

function Loaded({
  ctx,
  last,
  fixed: fixedAtOpen,
  offers,
  libraries,
  calendars,
  athlete,
  devices,
  bicycle,
}: {
  readonly ctx: UiContext;
  readonly last: Parameters<typeof startingAnswers>[0];
  readonly fixed: Parameters<typeof startingAnswers>[1];
  readonly offers: readonly RouteOffer[];
  readonly libraries: ReadonlyMap<string, Library>;
  readonly calendars: ReadonlyMap<string, Calendar>;
  readonly athlete: WorkoutAthlete;
  readonly devices: ReturnType<typeof mergeDeviceStatuses>;
  readonly bicycle: Bicycle | undefined;
}) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const root = useRef<HTMLElement>(null);
  const [{ answers: first, fixed: fixedFirst }] = useState(() => startingAnswers(last, fixedAtOpen));
  const [answers, setAnswers] = useState<Answers>(first);
  const [fixed, setFixed] = useState<Fixed>(fixedFirst);
  const [editing, setEditing] = useState<'route' | 'workout'>();
  const [problem, setProblem] = useState<'no-ftp' | 'no-power-zones'>();

  const offer = offerOf(answers.world, offers);
  const found: Found = useMemo(() => findWorkout(answers.workout, libraries, calendars), [answers.workout, libraries, calendars]);
  const loadingWorkout = found.state === 'missing' && stillLoading(answers.workout, libraries, calendars);
  const routeMissing = !!answers.world && !offer;
  const workoutMissing = found.state === 'missing' && !loadingWorkout;
  const routeOpen = answers.world === undefined || routeMissing || editing === 'route';
  const workoutOpen = answers.workout === undefined || workoutMissing || editing === 'workout';
  const options = useMemo(() => workoutOptions(libraries, calendars, localDate(Date.now())), [libraries, calendars]);
  const sortedOffers = useMemo(() => [...offers].sort((a, b) => a.title.localeCompare(b.title)), [offers]);

  const metrics = useMemo(
    () => (found.state === 'found' ? workoutMetrics(found.ride.workout, athlete) : undefined),
    [found, athlete],
  );

  // Where the focus goes after the next render: the first open choice, the start, or back to the
  // control whose choice was just made (the one that opened it vanished).
  const focusNext = useRef<string | undefined>(routeOpen ? 'pick-route' : workoutOpen ? 'pick-workout' : 'start');
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = undefined;
    const section = root.current;
    const element =
      target === 'start' || target.startsWith('change-')
        ? section?.querySelector<HTMLElement>(`[data-focus="${target}"]:not(:disabled)`)
        : (section?.querySelector<HTMLElement>(`[data-picker="${target.slice(5)}"] [aria-pressed="true"]`) ??
          section?.querySelector<HTMLElement>(`[data-picker="${target.slice(5)}"] button`));
    // The start can be disabled (the route is not here yet): then the control that led to it.
    (element ?? section?.querySelector<HTMLElement>('[data-focus^="change-"]'))?.focus();
  });

  const clearFixed = () => {
    ctx
      .call(rideBriefingSetService, { key: 'fixed', briefing: {} })
      .catch((error: unknown) => ctx.logger.warn('The briefing could not forget what was fixed', error));
  };
  const leave = () => {
    clearFixed();
    ctx.leave();
  };
  const back = useRef(() => {});
  back.current = () => {
    if (editing) {
      focusNext.current = `change-${editing}`;
      setEditing(undefined);
      return;
    }
    leave();
  };
  useEffect(() => ctx.onBack(() => back.current()), [ctx]);

  const pickWorld = (world: World | null) => {
    setAnswers((a) => ({ ...a, world }));
    setFixed((f) => ({ ...f, world: false }));
    setEditing(undefined);
    focusNext.current = workoutOpen ? 'pick-workout' : 'start';
  };
  const pickWorkout = (workout: WorkoutPick) => {
    setAnswers((a) => ({ ...a, workout }));
    setFixed((f) => ({ ...f, workout: false }));
    setEditing(undefined);
    setProblem(undefined);
    focusNext.current = routeOpen ? 'pick-route' : 'start';
  };

  const start = () => {
    let ride: RideWorkout | undefined;
    if (found.state === 'found') {
      const resolved = resolveForRide(found.ride, athlete);
      if (!resolved.ok) {
        setProblem(resolved.refusal);
        return;
      }
      ride = resolved.ride;
    }
    ctx
      .call(rideBriefingSetService, { key: 'last', briefing: rememberedChoice(answers.world, found, bicycle?.name) })
      .catch((error: unknown) => ctx.logger.warn('The briefing could not remember the choice', error));
    clearFixed();
    ctx.events.publish(activityStartRequestedEvent, {
      ...(answers.world ? { world: answers.world } : {}),
      ...(ride ? { workout: ride } : {}),
    });
  };

  const workoutSeconds = metrics?.durationSeconds;
  const note = lengthNote(workoutSeconds, offer?.duration);
  const trainer = devices.find((device) => device.kind === 'trainer');
  const heartRate = devices.find((device) => device.kind === 'heart-rate');
  const downloadable = offer && (offer.availability.state === 'fetchable' || offer.availability.state === 'failed');
  const routeReady = !offer || offer.availability.state === 'ready';

  const pair = (link: typeof trainer, label: string, pairLabel: string, kind: string) => {
    const connected = link?.state === 'connected';
    return (
      <div className="br-row" data-testid={`briefing-${kind}`} data-connected={String(connected)}>
        <span className="br-status" data-ok={String(connected)}>
          <strong>{label}</strong>
          <span>{connected ? text.connected(link?.deviceName ?? '') : text.notConnected}</span>
        </span>
        {connected || !ctx.hasScreen(SETUP) ? null : (
          <button type="button" className="br-button" aria-label={pairLabel} onClick={() => ctx.navigate(SETUP)}>
            {text.pair}
          </button>
        )}
      </div>
    );
  };

  const workoutName = found.state === 'found' ? found.ride.workout.name : text.noWorkout;
  const routeName = answers.world ? (offer?.title ?? '') : text.freeRide;

  return (
    <main className="br-page" data-testid="briefing" aria-label={text.title} ref={root}>
      <BriefingStyles />
      <button type="button" className="br-button" style={{ alignSelf: 'flex-start' }} onClick={leave}>
        {text.back}
      </button>
      <h1 className="br-title">{text.title}</h1>

      <section className="br-section" aria-label={text.route} data-testid="briefing-route">
        <h2>{text.route}</h2>
        {routeOpen ? (
          <>
            {routeMissing ? <p className="br-hint">{text.routeMissing}</p> : null}
            <Picker id="route" label={text.route}>
              <Option chosen={answers.world === null} onPick={() => pickWorld(null)}>
                {text.freeRide}
              </Option>
              {sortedOffers.map((each) => (
                <Option
                  key={each.id}
                  chosen={sameWorld(answers.world, each.world)}
                  onPick={() => pickWorld(each.world)}
                  detail={`${localizeNumber((each.distance / 1000).toFixed(1), language)} km`}
                >
                  {each.title}
                </Option>
              ))}
            </Picker>
          </>
        ) : (
          <div className="br-row">
            <p className="br-value" data-testid="briefing-route-chosen" data-fixed={String(fixed.world)}>
              {routeName}
            </p>
            <button type="button" className="br-button" data-focus="change-route" onClick={() => {
              setEditing('route');
              focusNext.current = 'pick-route';
            }}>
              {text.changeRoute}
            </button>
          </div>
        )}
      </section>

      <section className="br-section" aria-label={text.workout} data-testid="briefing-workout">
        <h2>{text.workout}</h2>
        {workoutOpen ? (
          <>
            {workoutMissing ? <p className="br-hint">{text.workoutMissing}</p> : null}
            <Picker id="workout" label={text.workout}>
              <Option chosen={answers.workout?.kind === 'none'} onPick={() => pickWorkout({ kind: 'none' })}>
                {text.noWorkout}
              </Option>
              {options.planned.length > 0 ? <li className="br-group" aria-hidden="true">{text.planned}</li> : null}
              {options.planned.map((each: WorkoutOption) => (
                <Option
                  key={`planned/${each.pick.kind === 'planned' ? `${each.pick.from}/${each.pick.id}` : ''}`}
                  chosen={!!answers.workout && samePick(answers.workout, each.pick)}
                  onPick={() => pickWorkout(each.pick)}
                  detail={each.date}
                >
                  {each.name}
                </Option>
              ))}
              {options.library.length > 0 ? <li className="br-group" aria-hidden="true">{text.library}</li> : null}
              {options.library.map((each: WorkoutOption) => (
                <Option
                  key={`library/${each.pick.kind === 'library' ? `${each.pick.from}/${each.pick.workoutId}` : ''}`}
                  chosen={!!answers.workout && samePick(answers.workout, each.pick)}
                  onPick={() => pickWorkout(each.pick)}
                >
                  {each.name}
                </Option>
              ))}
            </Picker>
          </>
        ) : (
          <div className="br-row">
            <p className="br-value" data-testid="briefing-workout-chosen" data-fixed={String(fixed.workout)}>
              {workoutName}
            </p>
            <button type="button" className="br-button" data-focus="change-workout" onClick={() => {
              setEditing('workout');
              focusNext.current = 'pick-workout';
            }}>
              {text.changeWorkout}
            </button>
          </div>
        )}
      </section>

      {bicycle ? (
        <section className="br-section" aria-label={text.bicycle} data-testid="briefing-bicycle">
          <h2>{text.bicycle}</h2>
          <div className="br-row">
            <p className="br-value">{text.riding(bicycle.name, localizeNumber(bicycle.mass.toFixed(1), language))}</p>
            {ctx.hasScreen(GARAGE) ? (
              <button type="button" className="br-button" data-focus="change-bicycle" onClick={() => ctx.navigate(GARAGE)}>
                {text.changeBicycle}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {offer ? <RoutePreview ctx={ctx} offer={offer} label={text.routeProfile} /> : null}
      {found.state === 'found' ? (
        <ChartPreview
          ctx={ctx}
          workout={found.ride.workout}
          athlete={athlete}
          label={text.workoutChart}
          fallback={text.chartFallback(
            durationText(metrics?.durationSeconds ?? 0),
            metrics?.trainingLoad === undefined ? undefined : String(Math.round(metrics.trainingLoad)),
          )}
        />
      ) : null}

      <Summary text={text} language={language} metrics={metrics} offer={offer} athlete={athlete} />
      {note && workoutSeconds !== undefined && offer?.duration !== undefined ? (
        <p className="br-note" role="note" data-testid="briefing-note">
          {note === 'workout-longer'
            ? text.workoutLonger(text.minutes(workoutSeconds), text.minutes(offer.duration))
            : text.routeLonger(text.minutes(workoutSeconds), text.minutes(offer.duration))}
        </p>
      ) : null}

      <section className="br-section" aria-label={text.ready} data-testid="briefing-ready">
        <h2>{text.ready}</h2>
        {pair(trainer, text.trainer, text.pairTrainer, 'trainer')}
        {pair(heartRate, text.heartRate, text.pairHeartRate, 'heart-rate')}
        {offer ? (
          <div className="br-row" data-testid="briefing-route-ready" data-ready={String(routeReady)}>
            <span className="br-status" data-ok={String(routeReady)}>
              <strong>{text.route}</strong>
              <span>{routeReady ? text.routeReady : text.routeNotReady}</span>
            </span>
            {downloadable ? (
              <button
                type="button"
                className="br-button"
                aria-label={text.downloadRoute}
                onClick={() =>
                  ctx
                    .call(routeFetchService, { key: offer.id })
                    .catch((error: unknown) => ctx.logger.warn('The route could not be downloaded', error))
                }
              >
                {text.download}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {problem ? (
        <p className="br-problem" role="alert" data-testid="briefing-problem">
          {text.refusal[problem]}
        </p>
      ) : null}
      <button
        type="button"
        className="br-button br-primary"
        style={{ alignSelf: 'flex-start' }}
        data-focus="start"
        data-testid="briefing-start"
        disabled={!routeReady || routeOpen || workoutOpen || loadingWorkout}
        onClick={start}
      >
        {text.start}
      </button>
    </main>
  );
}

function BriefingView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const briefing = useWatched<RideBriefing>(ctx, rideBriefingState);
  const offers = useWatched<RouteOffer>(ctx, routeOfferState);
  const libraries = useWatched<Library>(ctx, trainingLibraryState);
  const calendars = useWatched<Calendar>(ctx, trainingCalendarState);
  const profiles = useWatched<DataSource<AthleteProfile>>(ctx, athleteProfileState);
  const choices = useWatched<DataSourceChoice>(ctx, dataSourceState);
  const devices = useWatched<DeviceStatus>(ctx, deviceStatusState);
  const [bicycle, setBicycle] = useState<Bicycle>();
  useEffect(() => ctx.events.subscribe(equipmentBicycleChangedEvent, ({ payload }) => setBicycle(payload)), [ctx]);
  const athlete = useMemo(
    () => (profiles && choices ? chosenAthlete(profiles, choices) : {}),
    [profiles, choices],
  );
  const merged = useMemo(() => mergeDeviceStatuses(devices?.values() ?? []), [devices]);
  const offerList = useMemo(() => [...(offers?.values() ?? [])], [offers]);

  // The briefing starts from what it knows when it opens; later changes of the state do not move
  // the rider's choices under them.
  if (!briefing || !offers || !libraries || !calendars || !profiles || !choices || !devices) {
    return (
      <main className="br-page" data-testid="briefing-loading">
        <BriefingStyles />
        <p className="br-hint">{text.loading}</p>
      </main>
    );
  }
  return (
    <Loaded
      ctx={ctx}
      last={briefing.get('last')}
      fixed={briefing.get('fixed')}
      offers={offerList}
      libraries={libraries}
      calendars={calendars}
      athlete={athlete}
      devices={merged}
      bicycle={bicycle}
    />
  );
}

export const Briefing: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<BriefingView ctx={ctx} />);
  return () => root.unmount();
};
