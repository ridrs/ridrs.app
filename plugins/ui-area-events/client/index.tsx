// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AreaPage,
  MenuEntry,
  reactComponent,
  TodayCard,
  Toggle,
  useBack,
  userDocument,
} from '@ridrs/ui-preview';
import type { UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { z } from 'zod';
import { type Messages, messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const TROPHY = new URL('./assets/icons/trophy.svg', import.meta.url).href;

type Kind = 'race' | 'group' | 'challenge' | 'club';

type EventId = keyof Messages['events'];

/** Placeholders of the early alpha, in the order they take place; their texts are in `i18n`. */
const EVENTS: readonly { readonly id: EventId; readonly kind: Kind }[] = [
  { id: 'tempo', kind: 'group' },
  { id: 'crit', kind: 'race' },
  { id: 'club-race', kind: 'race' },
  { id: 'everest', kind: 'challenge' },
  { id: 'distance', kind: 'challenge' },
  { id: 'club', kind: 'club' },
];

const SECTIONS: readonly Kind[] = ['race', 'group', 'challenge', 'club'];

/** What the rider changed in this area, kept at once (ADR 0059). */
const useEvents = userDocument(
  {
    name: 'preview',
    version: 1,
    schema: z.object({ joined: z.array(z.string()), showOnToday: z.boolean() }).strict(),
  },
  { joined: [] as string[], showOnToday: true },
);

function EventsAreaView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useEvents(ctx);
  useBack(ctx);
  return (
    <AreaPage title={text.title} intro={text.intro}>
      {SECTIONS.map((section) => (
        <section key={section} className="pv-section">
          <h2>{text.sections[section]}</h2>
          <div className="pv-cards">
            {EVENTS.filter((event) => event.kind === section).map((event) => {
              const joined = state.joined.includes(event.id);
              const about = text.events[event.id];
              return (
                <article key={event.id} className="pv-card">
                  <h3>{about.name}</h3>
                  <span className="pv-muted">
                    {about.when} · {about.about}
                  </span>
                  <div className="pv-row">
                    <Toggle
                      label={text.join(about.name)}
                      on={joined}
                      onChange={(on) =>
                        change((s) => ({
                          ...s,
                          joined: on ? [...s.joined, event.id] : s.joined.filter((id) => id !== event.id),
                        }))
                      }
                    >
                      {joined ? text.joined : text.joinShort}
                    </Toggle>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
      <section className="pv-section">
        <h2>{text.onToday}</h2>
        <div className="pv-row">
          <Toggle
            label={text.showOnToday}
            on={state.showOnToday}
            onChange={(on) => change((s) => ({ ...s, showOnToday: on }))}
          />
        </div>
      </section>
    </AreaPage>
  );
}

/** The card on Today: the first event the rider joined, or an invitation to join one. */
function NextEventView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const [state, change] = useEvents(ctx);
  if (!state.showOnToday) return null;
  const found = EVENTS.find((event) => state.joined.includes(event.id));
  const next = found && text.events[found.id];
  return (
    <TodayCard
      classifier={text.nextEvent}
      icon={TROPHY}
      title={next ? next.name : text.noneJoined}
      details={next ? [next.when, next.about] : [text.invitation]}
      onHide={() => change((s) => ({ ...s, showOnToday: false }))}
    >
      <div className="pv-row">
        <button type="button" className="pv-button" onClick={() => ctx.navigate('events')}>
          {next ? text.allEvents : text.findEvent}
        </button>
      </div>
    </TodayCard>
  );
}

export const EventsArea = reactComponent((ctx) => <EventsAreaView ctx={ctx} />);
export const NextEventTile = reactComponent((ctx) => <NextEventView ctx={ctx} />);
function EventsMenuEntryView({ ctx }: { readonly ctx: UiContext }) {
  return <MenuEntry ctx={ctx} screen="events" label={useMessages(ctx, messages).title} icon={TROPHY} />;
}

export const EventsMenuEntry = reactComponent((ctx) => <EventsMenuEntryView ctx={ctx} />);
