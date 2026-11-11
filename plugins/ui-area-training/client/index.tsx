// SPDX-License-Identifier: AGPL-3.0-or-later

import { AreaPage, iconStyle, PREVIEW_CSS, MenuEntry, reactComponent, Toggle, useBack } from '@ridrs/ui-preview';
import {
  DEFAULT_PROVIDER,
  type LibraryWorkout,
  trainingLibraryLoadService,
  trainingLibraryState,
  WORKOUT_FOCUSES,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import {
  type CatalogueFilter,
  type CatalogueItem,
  type DurationClass,
  durationClassesIn,
  focusesIn,
  passes,
} from './catalogue.ts';
import { type DetailsRequest, focusBack, focusKeyProps, OpenDetails, WorkoutDetailsView } from './details.tsx';
import { messages } from './i18n/index.ts';
import { catalogueMessages } from './i18n/catalogue.ts';
import { MonthCalendar, startDrag, WEEK_CSS, type Week, WeekCalendar, useWeek } from './week.tsx';
import { CHART_SLOT_CSS, type ChartAthlete, chartWorkout, useChartAthlete, WorkoutChartSlot } from './workout-chart.tsx';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const DUMBBELL = new URL('./assets/icons/dumbbell.svg', import.meta.url).href;
const BACK = new URL('./assets/icons/chevron-left.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;
/** By Munbaik Cycling Clothing on Unsplash (Unsplash License, see the folder's README). */
const PICTURE = new URL('./assets/pictures/hero.jpg', import.meta.url).href;

type Provider = { readonly provider: string; readonly label: string; readonly workouts: readonly LibraryWorkout[] };

/** One workout of a library: its chart (or its plain facts without the chart plugin), draggable, and Enter opens it. */
function LibraryCard({
  ctx,
  week,
  provider,
  workout,
  athlete,
  favourable = false,
}: {
  readonly ctx: UiContext;
  readonly week: Week;
  readonly provider: string;
  readonly workout: LibraryWorkout;
  readonly athlete: ChartAthlete | undefined;
  /** The workouts of this device can be marked as favourites. */
  readonly favourable?: boolean;
}) {
  const text = useMessages(ctx, messages);
  const open = useContext(OpenDetails);
  const { setDrag } = week;
  const [charted, setCharted] = useState(false);
  const chart = chartWorkout(workout);
  // The chart says duration and load itself; without it the card does.
  const facts = [
    workout.folder,
    ...(charted
      ? []
      : [
          workout.durationSeconds === undefined ? undefined : `${Math.round(workout.durationSeconds / 60)} min`,
          workout.trainingLoad === undefined ? undefined : `${Math.round(workout.trainingLoad)} TSS`,
        ]),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article
      className="pv-card tr-draggable tr-library-card"
      draggable
      data-library-workout={workout.id}
      onDragStart={startDrag({ kind: 'library', provider, workoutId: workout.id, name: workout.name }, setDrag)}
      onDragEnd={() => setDrag(undefined)}
    >
      {/* The card is one focus target: Enter opens the details (nothing opens without their plugin). */}
      <button
        type="button"
        className="pv-open tr-library-open"
        aria-label={workout.name}
        {...focusKeyProps(`library:${provider}:${workout.id}`)}
        onClick={() =>
          open({
            subject: { kind: 'library', from: provider, workoutId: workout.id },
            focusKey: `library:${provider}:${workout.id}`,
          })
        }
      >
        <h4>{workout.name}</h4>
        {facts ? <span className="pv-muted">{facts}</span> : null}
        {chart ? <WorkoutChartSlot ctx={ctx} workout={chart} athlete={athlete} variant="mini" onAvailability={setCharted} /> : null}
      </button>
      {favourable ? (
        <div className="pv-row">
          <Toggle
            className="pv-icon"
            label={text.favourite(workout.name)}
            on={week.favourites.includes(workout.id)}
            onChange={(on) =>
              week.change((s) => ({
                ...s,
                favourites: on ? [...s.favourites, workout.id] : s.favourites.filter((id) => id !== workout.id),
              }))
            }
          >
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(STAR)} />
          </Toggle>
        </div>
      ) : null}
    </article>
  );
}

/** Chips that narrow the catalogue; a chosen one is pressed, the same again lets everything through. */
function FilterGroup({
  title,
  options,
  chosen,
  onChoose,
  all,
}: {
  readonly title: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly chosen: string | undefined;
  readonly onChoose: (value: string | undefined) => void;
  readonly all: string;
}) {
  return (
    <div className="tr-filter-group" role="group" aria-label={title}>
      <span aria-hidden="true">{title}</span>
      <button type="button" className="pv-chip" aria-pressed={chosen === undefined} aria-label={`${title}: ${all}`} onClick={() => onChoose(undefined)}>
        {all}
      </button>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pv-chip"
          aria-pressed={chosen === option.value}
          aria-label={`${title}: ${option.label}`}
          onClick={() => onChoose(chosen === option.value ? undefined : option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The workouts of every provider's library, read only, grouped by provider (ADR 0075). */
function Library({
  ctx,
  week,
  providers,
  filter,
  athlete,
}: {
  readonly ctx: UiContext;
  readonly week: Week;
  readonly providers: readonly Provider[];
  readonly filter: CatalogueFilter;
  readonly athlete: ChartAthlete | undefined;
}) {
  const text = useMessages(ctx, messages);
  const browse = useMessages(ctx, catalogueMessages);
  const shown = providers
    .map((source) => ({
      ...source,
      workouts: source.workouts.filter((workout) => passes({ provider: source.provider, workout }, filter)),
    }))
    .filter((source) => source.workouts.length > 0);
  return (
    <section className="pv-section" data-testid="library">
      <h2>{text.library}</h2>
      {ctx.hasScreen(WORKOUT_IMPORT) ? (
        <button type="button" className="pv-button" data-testid="import-workouts" onClick={() => ctx.navigate(WORKOUT_IMPORT)}>
          {browse.importWorkouts}
        </button>
      ) : null}
      {providers.length === 0 ? <p className="pv-muted">{text.libraryEmpty}</p> : null}
      {providers.length > 0 && shown.length === 0 ? <p className="pv-muted">{browse.noMatch}</p> : null}
      {shown.map((source) => (
        <div key={source.provider} data-provider={source.provider}>
          <h3>{source.label}</h3>
          <div className="pv-cards">
            {source.workouts.map((workout) => (
              <LibraryCard key={workout.id} ctx={ctx} week={week} provider={source.provider} workout={workout} athlete={athlete} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/** The import of workout files (ui-workout-import), a dialog over the page when that plugin is there. */
const WORKOUT_IMPORT = 'workout-import';

function TrainingAreaView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  // The libraries of other providers are read when the area shows them, not at start (ADR 0078):
  // a provider with a valid library answers without a request.
  const libraryProviders = [...useStateEntries(ctx, trainingLibraryState).keys()]
    .filter((provider) => provider !== DEFAULT_PROVIDER)
    .sort()
    .join(',');
  useEffect(() => {
    for (const key of libraryProviders.split(',').filter((provider) => provider !== '')) {
      ctx
        .call(trainingLibraryLoadService, { key })
        .catch((error: unknown) => ctx.logger.warn(`The library of "${key}" could not be asked for: ${String(error)}`));
    }
  }, [ctx, libraryProviders]);
  const week = useWeek(ctx);
  const { setDrag } = week;
  const browse = useMessages(ctx, catalogueMessages);
  const athlete = useChartAthlete(ctx);
  const libraries = useStateEntries(ctx, trainingLibraryState);
  const [filter, setFilter] = useState<CatalogueFilter>({});
  const sources = useMemo(
    () =>
      [...libraries.values()]
        .map((source): Provider => ({
          provider: source.provider,
          label: source.provider === DEFAULT_PROVIDER ? text.thisDevice : source.label,
          workouts: source.data?.workouts ?? [],
        }))
        .filter((source) => source.workouts.length > 0)
        .sort((a, b) => a.provider.localeCompare(b.provider)),
    [libraries, text],
  );
  const catalogue = useMemo<CatalogueItem[]>(
    () => sources.flatMap((source) => source.workouts.map((workout) => ({ provider: source.provider, workout }))),
    [sources],
  );
  // The workouts of this device are the section "Workouts"; the placeholders stand in until it has its own.
  const own = sources.find((source) => source.provider === DEFAULT_PROVIDER);
  const others = sources.filter((source) => source.provider !== DEFAULT_PROVIDER);
  const filtering = filter.focus !== undefined || filter.duration !== undefined || filter.provider !== undefined;
  const choose = (field: keyof CatalogueFilter) => (value: string | undefined) =>
    setFilter((was) => {
      const { [field]: _, ...rest } = was;
      return value === undefined ? rest : { ...rest, [field]: value };
    });
  // The details of a workout are an inner view of the area, in place of its content; closing them
  // gives the focus back to the card or entry that opened them.
  const [opened, setOpened] = useState<DetailsRequest>();
  const returnTo = useRef<string | undefined>(undefined);
  const open = useCallback((request: DetailsRequest) => setOpened(request), []);
  const current = useRef<DetailsRequest | undefined>(undefined);
  current.current = opened;
  const close = useCallback(() => {
    if (current.current) returnTo.current = current.current.focusKey;
    setOpened(undefined);
  }, []);
  useEffect(() => {
    if (opened !== undefined || returnTo.current === undefined) return;
    focusBack(returnTo.current);
    returnTo.current = undefined;
  }, [opened]);
  // The large calendar is a subpage of the area: Back leaves it for the area first.
  const [large, setLarge] = useState(false);
  useBack(ctx, () => {
    if (opened) {
      close();
      return true;
    }
    if (large) {
      setLarge(false);
      return true;
    }
    // Back first takes the filters off, then leaves the area.
    if (filtering) {
      setFilter({});
      return true;
    }
    return false;
  });

  if (opened) {
    return <WorkoutDetailsView ctx={ctx} subject={opened.subject} onClose={close} />;
  }

  if (large) {
    return (
      <div className="pv-page" data-testid="large-calendar">
        <style>{PREVIEW_CSS}</style>
        <style>{WEEK_CSS}</style>
        <style>{CHART_SLOT_CSS}</style>
        <header className="pv-title">
          <button type="button" className="pv-button" onClick={() => setLarge(false)}>
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(BACK)} />
            {text.back}
          </button>
          <h1>{text.calendar}</h1>
        </header>
        <OpenDetails.Provider value={open}>
          <MonthCalendar ctx={ctx} week={week} />
        </OpenDetails.Provider>
      </div>
    );
  }

  return (
    <OpenDetails.Provider value={open}>
    <AreaPage title={text.title} intro={text.intro} picture={{ image: PICTURE, credits: text.pictureCredits }}>
      <style>{WEEK_CSS}</style>
      <style>{CHART_SLOT_CSS}</style>
      <section className="pv-section">
        <WeekCalendar ctx={ctx} week={week} onOpenLarge={() => setLarge(true)} />
        <p className="pv-muted">{text.exportLater}</p>
      </section>

      {catalogue.length > 0 ? (
        <section className="pv-section tr-filters" data-testid="catalogue-filters" aria-label={browse.filters}>
          <FilterGroup
            title={browse.focus}
            all={browse.all}
            chosen={filter.focus}
            onChoose={choose('focus')}
            options={focusesIn(catalogue, WORKOUT_FOCUSES).map((value) => ({ value, label: browse.focuses[value] ?? value }))}
          />
          <FilterGroup
            title={browse.duration}
            all={browse.all}
            chosen={filter.duration}
            onChoose={choose('duration')}
            options={durationClassesIn(catalogue).map((value: DurationClass) => ({ value, label: browse.durations[value] }))}
          />
          {sources.length > 1 ? (
            <FilterGroup
              title={browse.provider}
              all={browse.all}
              chosen={filter.provider}
              onChoose={choose('provider')}
              options={sources.map((source) => ({ value: source.provider, label: source.label }))}
            />
          ) : null}
        </section>
      ) : null}

      {own ? (
        <section className="pv-section">
          <h2>{text.workouts}</h2>
          <div className="pv-cards" data-testid="own-workouts">
            {own.workouts
              .filter((workout) => passes({ provider: own.provider, workout }, filter))
              .map((workout) => (
                <LibraryCard key={workout.id} ctx={ctx} week={week} provider={own.provider} workout={workout} athlete={athlete} favourable />
              ))}
          </div>
        </section>
      ) : null}

      <Library ctx={ctx} week={week} providers={others} filter={filter} athlete={athlete} />

      <section className="pv-section">
        <h2>{text.plans}</h2>
        <div className="pv-cards">
          <article className="pv-card">
            <h3>Base Builder</h3>
            <span className="pv-muted">{text.baseBuilder}</span>
          </article>
          <article className="pv-card">
            <h3>FTP Builder</h3>
            <span className="pv-muted">{text.ftpBuilder}</span>
          </article>
        </div>
      </section>

      <section className="pv-section">
        <h2>{text.suggestion}</h2>
        <article className="pv-card">
          <span className="pv-muted">{text.suggestionLater}</span>
        </article>
      </section>
    </AreaPage>
    </OpenDetails.Provider>
  );
}

export const TrainingArea = reactComponent((ctx) => <TrainingAreaView ctx={ctx} />);

function TrainingMenuEntryView({ ctx }: { readonly ctx: UiContext }) {
  return <MenuEntry ctx={ctx} screen="training" label={useMessages(ctx, messages).title} icon={DUMBBELL} />;
}

export const TrainingMenuEntry = reactComponent((ctx) => <TrainingMenuEntryView ctx={ctx} />);
