// SPDX-License-Identifier: AGPL-3.0-or-later

import { AreaPage, iconStyle, PREVIEW_CSS, MenuEntry, reactComponent, Toggle, useBack } from '@ridrs/ui-preview';
import { DEFAULT_PROVIDER, trainingLibraryLoadService, trainingLibraryState } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { WORKOUTS } from './calendar.ts';
import { messages } from './i18n/index.ts';
import { startDrag, WEEK_CSS, type Week, WeekCalendar, useWeek } from './week.tsx';

/** From Lucide (ISC, see the folder's LICENSE), painted as masks in the text colour. */
const DUMBBELL = new URL('./assets/icons/dumbbell.svg', import.meta.url).href;
const BACK = new URL('./assets/icons/chevron-left.svg', import.meta.url).href;
const STAR = new URL('./assets/icons/star.svg', import.meta.url).href;
/** By Munbaik Cycling Clothing on Unsplash (Unsplash License, see the folder's README). */
const PICTURE = new URL('./assets/pictures/hero.jpg', import.meta.url).href;

/** The workouts of every provider's library, read only, grouped by provider (ADR 0075). */
function Library({ ctx, week }: { readonly ctx: UiContext; readonly week: Week }) {
  const { setDrag } = week;
  const text = useMessages(ctx, messages);
  const providers = [...useStateEntries(ctx, trainingLibraryState).values()]
    // The workouts of this device are the section "Workouts" above.
    .filter((source) => source.provider !== DEFAULT_PROVIDER && (source.data?.workouts.length ?? 0) > 0)
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return (
    <section className="pv-section" data-testid="library">
      <h2>{text.library}</h2>
      {providers.length === 0 ? <p className="pv-muted">{text.libraryEmpty}</p> : null}
      {providers.map((source) => (
        <div key={source.provider} data-provider={source.provider}>
          <h3>{source.provider === DEFAULT_PROVIDER ? text.thisDevice : source.label}</h3>
          <div className="pv-cards">
            {source.data?.workouts.map((workout) => (
              <article
                key={workout.id}
                className="pv-card tr-draggable"
                draggable
                data-library-workout={workout.id}
                onDragStart={startDrag(
                  { kind: 'library', provider: source.provider, workoutId: workout.id, name: workout.name },
                  setDrag,
                )}
                onDragEnd={() => setDrag(undefined)}
              >
                <h4>{workout.name}</h4>
                <span className="pv-muted">
                  {[
                    workout.folder,
                    workout.durationSeconds === undefined
                      ? undefined
                      : `${Math.round(workout.durationSeconds / 60)} min`,
                    workout.trainingLoad === undefined ? undefined : `${Math.round(workout.trainingLoad)} TSS`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

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
  // The large calendar is a subpage of the area: Back leaves it for the area first.
  const [large, setLarge] = useState(false);
  useBack(ctx, () => {
    if (large) {
      setLarge(false);
      return true;
    }
    return false;
  });

  if (large) {
    return (
      <div className="pv-page" data-testid="large-calendar">
        <style>{PREVIEW_CSS}</style>
        <style>{WEEK_CSS}</style>
        <header className="pv-title">
          <button type="button" className="pv-button" onClick={() => setLarge(false)}>
            <span className="pv-glyph" aria-hidden="true" style={iconStyle(BACK)} />
            {text.back}
          </button>
          <h1>{text.calendar}</h1>
        </header>
        <WeekCalendar ctx={ctx} week={week} large />
      </div>
    );
  }

  return (
    <AreaPage title={text.title} intro={text.intro} picture={{ image: PICTURE, credits: text.pictureCredits }}>
      <style>{WEEK_CSS}</style>
      <section className="pv-section">
        <WeekCalendar ctx={ctx} week={week} onOpenLarge={() => setLarge(true)} />
        <p className="pv-muted">{text.exportLater}</p>
      </section>

      <section className="pv-section">
        <h2>{text.workouts}</h2>
        <div className="pv-cards">
          {WORKOUTS.map((workout) => (
            <article
              key={workout.id}
              className="pv-card tr-draggable"
              draggable
              onDragStart={startDrag({ kind: 'library', provider: DEFAULT_PROVIDER, workoutId: workout.id, name: workout.name }, setDrag)}
              onDragEnd={() => setDrag(undefined)}
            >
              <h3>{workout.name}</h3>
              <span className="pv-muted">
                {workout.minutes} min · TSS {workout.tss} · {text.zones[workout.id] ?? workout.zone}
              </span>
              <div className="pv-row">
                <Toggle
                  className="pv-icon"
                  label={text.favourite(workout.name)}
                  on={week.favourites.includes(workout.id)}
                  onChange={(on) =>
                    week.change((s) => ({
                      ...s,
                      favourites: on
                        ? [...s.favourites, workout.id]
                        : s.favourites.filter((id) => id !== workout.id),
                    }))
                  }
                >
                  <span className="pv-glyph" aria-hidden="true" style={iconStyle(STAR)} />
                </Toggle>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Library ctx={ctx} week={week} />

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
  );
}

export const TrainingArea = reactComponent((ctx) => <TrainingAreaView ctx={ctx} />);

function TrainingMenuEntryView({ ctx }: { readonly ctx: UiContext }) {
  return <MenuEntry ctx={ctx} screen="training" label={useMessages(ctx, messages).title} icon={DUMBBELL} />;
}

export const TrainingMenuEntry = reactComponent((ctx) => <TrainingMenuEntryView ctx={ctx} />);
