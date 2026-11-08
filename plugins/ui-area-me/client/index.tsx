// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ActionButton,
  AreaPage,
  reactComponent,
  TodayCard,
  Toggle,
  useBack,
  userDocument,
} from '@ridrs/ui-preview';
import { localizeNumber, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const USER = new URL('./assets/icons/user.svg', import.meta.url).href;

const CSS = `
.me-stepper { display: grid; grid-template-columns: 1fr auto auto auto; align-items: center; gap: 10px;
  max-width: 420px; }
.me-stepper output { min-width: 80px; font-size: 20px; font-weight: 700; text-align: center; }
`;

// The tile is drawn without the area's style sheet, so its bar carries its own style.
const BAR = {
  height: 10,
  overflow: 'hidden',
  borderRadius: 999,
  background: 'var(--ridrs-surface-raised, #1a2540)',
} as const;
const FILL = { display: 'block', height: '100%', background: 'var(--ridrs-accent, #b8f53b)' } as const;

/** Hours ridden this week: a placeholder until rides are summed up. */
const RIDDEN_HOURS = 2.5;

/**
 * What the rider changed in this area, kept at once (ADR 0059). FTP and weight are placeholders:
 * nothing in the ride reads them yet.
 */
const useMe = userDocument(
  {
    name: 'preview',
    version: 1,
    schema: z
      .object({
        ftp: z.number().int().min(50).max(600),
        weight: z.number().min(30).max(200),
        weeklyHours: z.number().min(0.5).max(30),
        showOnToday: z.boolean(),
      })
      .strict(),
  },
  { ftp: 200, weight: 72, weeklyHours: 5, showOnToday: true },
);

/** A value changed in steps with two buttons: usable with arrows and Enter alone. */
function Stepper({
  ctx,
  name,
  value,
  testId,
  onStep,
}: {
  readonly ctx: UiContext;
  readonly name: string;
  readonly value: string;
  readonly testId: string;
  readonly onStep: (direction: 1 | -1) => void;
}) {
  const text = useMessages(ctx, messages);
  return (
    <div className="me-stepper">
      <span>{name}</span>
      <button type="button" className="pv-icon" aria-label={text.lower(name)} onClick={() => onStep(-1)}>
        −
      </button>
      <output data-testid={testId} aria-label={name}>
        {value}
      </output>
      <button type="button" className="pv-icon" aria-label={text.raise(name)} onClick={() => onStep(1)}>
        +
      </button>
    </div>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Where services such as a training planner are connected and disconnected: other plugins contribute them. */
const CONNECTION_SLOT = 'me/connection';

function MeAreaView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const [state, change] = useMe(ctx);
  const connections = useRef<HTMLDivElement>(null);
  useBack(ctx);
  useEffect(() => (connections.current ? ctx.slot(CONNECTION_SLOT, connections.current) : undefined), [ctx]);
  const wattsPerKg = localizeNumber((state.ftp / state.weight).toFixed(2), language);
  return (
    <AreaPage title={text.title} intro={text.intro}>
      <style>{CSS}</style>
      <section className="pv-section">
        <h2>{text.progress}</h2>
        <Stepper
          ctx={ctx}
          name={text.ftp}
          testId="ftp"
          value={`${state.ftp} W`}
          onStep={(d) => change((s) => ({ ...s, ftp: clamp(s.ftp + 5 * d, 50, 600) }))}
        />
        <Stepper
          ctx={ctx}
          name={text.weight}
          testId="weight"
          value={`${localizeNumber(state.weight.toFixed(1), language)} kg`}
          onStep={(d) => change((s) => ({ ...s, weight: clamp(s.weight + 0.5 * d, 30, 200) }))}
        />
        <Stepper
          ctx={ctx}
          name={text.weeklyGoal}
          testId="weekly-goal"
          value={`${localizeNumber(String(state.weeklyHours), language)} h`}
          onStep={(d) => change((s) => ({ ...s, weeklyHours: clamp(s.weeklyHours + 0.5 * d, 0.5, 30) }))}
        />
        <p className="pv-muted">{text.notUsed(wattsPerKg)}</p>
      </section>
      <section className="pv-section">
        <h2>{text.activities}</h2>
        <div className="pv-card">
          <span className="pv-muted">{text.activitiesSoon}</span>
        </div>
      </section>
      <section className="pv-section">
        <h2>{text.achievements}</h2>
        <div className="pv-cards">
          <article className="pv-card">
            <h3>{text.first100}</h3>
            <span className="pv-muted">{text.first100About}</span>
          </article>
          <article className="pv-card">
            <h3>{text.climber}</h3>
            <span className="pv-muted">{text.climberAbout}</span>
          </article>
        </div>
      </section>
      <section className="pv-section">
        <h2>{text.account}</h2>
        <div className="pv-card">
          <span className="pv-muted">{text.accountSoon}</span>
        </div>
      </section>
      <section className="pv-section">
        <h2>{text.connected}</h2>
        <div ref={connections} data-testid="slot-me-connection" />
      </section>
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

/** The card on Today: this week's hours against the goal. */
function WeeklyGoalView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const [state, change] = useMe(ctx);
  if (!state.showOnToday) return null;
  const share = Math.min(1, RIDDEN_HOURS / state.weeklyHours);
  return (
    <TodayCard
      classifier={text.weeklyGoal}
      icon={USER}
      title={text.hoursOf(
        localizeNumber(String(RIDDEN_HOURS), language),
        localizeNumber(String(state.weeklyHours), language),
      )}
      details={[text.shareOfGoal(Math.round(share * 100))]}
      onHide={() => change((s) => ({ ...s, showOnToday: false }))}
    >
      <div role="progressbar" aria-label={text.weeklyGoal} aria-valuenow={Math.round(share * 100)} style={BAR}>
        <i style={{ ...FILL, width: `${share * 100}%` }} />
      </div>
      <div className="pv-row">
        <button type="button" className="pv-button" onClick={() => ctx.navigate('me')}>
          {text.changeGoal}
        </button>
      </div>
    </TodayCard>
  );
}

export const MeArea = reactComponent((ctx) => <MeAreaView ctx={ctx} />);
export const WeeklyGoalTile = reactComponent((ctx) => <WeeklyGoalView ctx={ctx} />);
function ProfileActionView({ ctx }: { readonly ctx: UiContext }) {
  return <ActionButton ctx={ctx} screen="me" label={useMessages(ctx, messages).profile} icon={USER} />;
}

export const ProfileAction = reactComponent((ctx) => <ProfileActionView ctx={ctx} />);
