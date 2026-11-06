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
import { z } from 'zod';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const TROPHY = new URL('./assets/icons/trophy.svg', import.meta.url).href;

type Kind = 'race' | 'group' | 'challenge' | 'club';

/** Placeholders of the early alpha, in the order they take place. */
interface RidrsEvent {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  readonly when: string;
  readonly about: string;
}

const EVENTS: readonly RidrsEvent[] = [
  { id: 'tempo', name: 'Tuesday Tempo Ride', kind: 'group', when: 'Tue 18:30', about: '60 min at 2.8 W/kg, no drop' },
  { id: 'crit', name: 'Thursday Crit Series', kind: 'race', when: 'Thu 19:00', about: '25 km, categories A–D' },
  { id: 'club-race', name: 'Sunday Club Race', kind: 'race', when: 'Sun 10:00', about: '42 km on the Alpine Loop' },
  { id: 'everest', name: 'Everest Challenge', kind: 'challenge', when: 'This month', about: '8,848 m of climbing' },
  { id: 'distance', name: '500 km in November', kind: 'challenge', when: 'This month', about: 'Ride 500 km' },
  { id: 'club', name: 'ridrs Riders Club', kind: 'club', when: 'Always', about: 'Weekly rides and a team chat' },
];

const SECTIONS: readonly { readonly kind: Kind; readonly title: string }[] = [
  { kind: 'race', title: 'Races' },
  { kind: 'group', title: 'Group rides' },
  { kind: 'challenge', title: 'Challenges' },
  { kind: 'club', title: 'Clubs and teams' },
];

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
  const [state, change] = useEvents(ctx);
  useBack(ctx);
  return (
    <AreaPage title="Events" intro="Ride together: races, group rides, challenges and clubs.">
      {SECTIONS.map((section) => (
        <section key={section.kind} className="pv-section">
          <h2>{section.title}</h2>
          <div className="pv-cards">
            {EVENTS.filter((event) => event.kind === section.kind).map((event) => {
              const joined = state.joined.includes(event.id);
              return (
                <article key={event.id} className="pv-card">
                  <h3>{event.name}</h3>
                  <span className="pv-muted">
                    {event.when} · {event.about}
                  </span>
                  <div className="pv-row">
                    <Toggle
                      label={`Join ${event.name}`}
                      on={joined}
                      onChange={(on) =>
                        change((s) => ({
                          ...s,
                          joined: on ? [...s.joined, event.id] : s.joined.filter((id) => id !== event.id),
                        }))
                      }
                    >
                      {joined ? 'Joined' : 'Join'}
                    </Toggle>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
      <section className="pv-section">
        <h2>On Today</h2>
        <div className="pv-row">
          <Toggle
            label="Show Next event on Today"
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
  const [state, change] = useEvents(ctx);
  if (!state.showOnToday) return null;
  const next = EVENTS.find((event) => state.joined.includes(event.id));
  return (
    <TodayCard title="Next event" onHide={() => change((s) => ({ ...s, showOnToday: false }))}>
      {next ? (
        <>
          <strong>{next.name}</strong>
          <span className="pv-muted">
            {next.when} · {next.about}
          </span>
        </>
      ) : (
        <span className="pv-muted">No event joined yet.</span>
      )}
      <div className="pv-row">
        <button type="button" className="pv-button" onClick={() => ctx.navigate('events')}>
          {next ? 'All events' : 'Find an event'}
        </button>
      </div>
    </TodayCard>
  );
}

export const EventsArea = reactComponent((ctx) => <EventsAreaView ctx={ctx} />);
export const NextEventTile = reactComponent((ctx) => <NextEventView ctx={ctx} />);
export const EventsMenuEntry = reactComponent((ctx) => (
  <MenuEntry ctx={ctx} screen="events" label="Events" icon={TROPHY} />
));
