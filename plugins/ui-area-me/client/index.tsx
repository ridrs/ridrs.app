// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  athleteProfileState,
  athleteProfileUpdateService,
  DEFAULT_PROVIDER,
  type DataWriteResult,
  dataSourceState,
} from '@ridrs/contracts';
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
import { useLanguage, useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { useEffect, useRef, useState } from 'react';
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
 * What the rider changed in this area, kept at once (ADR 0059). Not strict: documents kept before
 * the athlete profile (ADR 0073) still hold the FTP and weight, which the host side hands to the
 * profile on this device.
 */
const useMe = userDocument(
  {
    name: 'preview',
    version: 1,
    schema: z.object({
      weeklyHours: z.number().min(0.5).max(30),
      showOnToday: z.boolean(),
    }),
  },
  { weeklyHours: 5, showOnToday: true },
);

/** Where the first step of an unset FTP or weight starts. */
const FIRST_FTP = 200;
const FIRST_WEIGHT = 75;

/**
 * The athlete profile of the chosen data source (ADR 0073): its FTP and weight, whether it can be
 * changed, and a call that changes them through `athlete.profile.update`, which the host routes to
 * the provider. A step starts from the value last asked for while the source has not shown it yet
 * (two quick steps are two steps); a refused change says why and leaves the old value.
 */
function useAthleteProfile(ctx: UiContext) {
  const providers = useStateEntries(ctx, athleteProfileState);
  const chosen = useStateEntries(ctx, dataSourceState).get('athlete.profile')?.provider;
  const provider = chosen ?? DEFAULT_PROVIDER;
  const source = providers.get(provider);
  const [refusal, setRefusal] = useState<DataWriteResult & { ok: false }>();
  const asked = useRef<{ ftp?: number; weight?: number }>({});
  // The source shows what was asked for: the value is its own again.
  useEffect(() => {
    for (const name of ['ftp', 'weight'] as const) {
      if (source?.data?.[name] === asked.current[name]) {
        delete asked.current[name];
      }
    }
  }, [source]);
  const update = (change: { ftp?: number; weight?: number }) => {
    asked.current = { ...asked.current, ...change };
    ctx.call(athleteProfileUpdateService, { key: provider, ...change }).then(
      (answer) => {
        setRefusal(answer.ok ? undefined : answer);
        if (!answer.ok) asked.current = {};
      },
      (error: unknown) => {
        asked.current = {};
        ctx.logger.warn(`Could not change the athlete profile: ${String(error)}`);
      },
    );
  };
  return {
    source,
    update,
    refusal,
    /** The value to show and to step from. */
    current: (name: 'ftp' | 'weight') => asked.current[name] ?? source?.data?.[name],
  };
}

/** A value changed in steps with two buttons: usable with arrows and Enter alone. */
function Stepper({
  ctx,
  name,
  value,
  testId,
  disabled = false,
  onStep,
}: {
  readonly ctx: UiContext;
  readonly name: string;
  readonly value: string;
  readonly testId: string;
  /** A value that cannot be changed here. */
  readonly disabled?: boolean;
  readonly onStep: (direction: 1 | -1) => void;
}) {
  const text = useMessages(ctx, messages);
  return (
    <div className="me-stepper">
      <span>{name}</span>
      <button
        type="button"
        className="pv-icon"
        aria-label={text.lower(name)}
        disabled={disabled}
        onClick={() => onStep(-1)}
      >
        −
      </button>
      <output data-testid={testId} aria-label={name}>
        {value}
      </output>
      <button
        type="button"
        className="pv-icon"
        aria-label={text.raise(name)}
        disabled={disabled}
        onClick={() => onStep(1)}
      >
        +
      </button>
    </div>
  );
}

/** What an unset FTP or weight shows. */
const NOT_SET = '–';

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
  const { source, update, refusal, current } = useAthleteProfile(ctx);
  const ftp = current('ftp');
  const weight = current('weight');
  // Only a source known to be read only holds the buttons back: before it is known, they work.
  const readOnly = source !== undefined && !source.writable;
  const sourceName = source?.provider === DEFAULT_PROVIDER ? text.thisDevice : source?.label;
  const wattsPerKg =
    ftp !== undefined && weight !== undefined
      ? localizeNumber((ftp / weight).toFixed(2), language)
      : undefined;
  return (
    <AreaPage title={text.title} intro={text.intro}>
      <style>{CSS}</style>
      <section className="pv-section">
        <h2>{text.progress}</h2>
        <Stepper
          ctx={ctx}
          name={text.ftp}
          testId="ftp"
          value={ftp === undefined ? NOT_SET : `${ftp} W`}
          disabled={readOnly}
          onStep={(d) => update({ ftp: clamp((current('ftp') ?? FIRST_FTP) + 5 * d, 50, 600) })}
        />
        <Stepper
          ctx={ctx}
          name={text.weight}
          testId="weight"
          value={weight === undefined ? NOT_SET : `${localizeNumber(weight.toFixed(1), language)} kg`}
          disabled={readOnly}
          onStep={(d) => update({ weight: clamp((current('weight') ?? FIRST_WEIGHT) + 0.5 * d, 30, 200) })}
        />
        <Stepper
          ctx={ctx}
          name={text.weeklyGoal}
          testId="weekly-goal"
          value={`${localizeNumber(String(state.weeklyHours), language)} h`}
          onStep={(d) => change((s) => ({ ...s, weeklyHours: clamp(s.weeklyHours + 0.5 * d, 0.5, 30) }))}
        />
        {source ? (
          <p className="pv-muted">
            {wattsPerKg ? `${text.wattsPerKg(wattsPerKg)} ` : ''}
            {text.fromSource(sourceName ?? '')}
            {source.writable ? '' : ` ${text.readOnly(sourceName ?? '')}`}
          </p>
        ) : null}
        {refusal ? (
          <p className="pv-muted" role="status">
            {text.refused(sourceName ?? '', refusal.reason)}
          </p>
        ) : null}
        <p className="pv-muted">{text.rideUses}</p>
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
