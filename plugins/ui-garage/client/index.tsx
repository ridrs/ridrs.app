// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStateChangedEvent, equipmentBicycleChangedEvent, type ShiftMode } from '@ridrs/contracts';
import { ActionButton, iconStyle, PREVIEW_CSS, reactComponent, useBack, userDocument } from '@ridrs/ui-preview';
import { localizeNumber, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import {
  BICYCLE_DOCUMENT,
  type BicycleDocument,
  DEFAULT_BICYCLE,
  resolveBicycle,
  specificationOf,
} from '../bicycle.ts';
import { messages } from './i18n/index.ts';

/** From Lucide (ISC, see the folder's LICENSE), painted as a mask in the text colour. */
const WRENCH = new URL('./assets/icons/wrench.svg', import.meta.url).href;
const WAREHOUSE = new URL('./assets/icons/warehouse.svg', import.meta.url).href;

const CSS = `
.ga-row { display: grid; grid-template-columns: 170px auto; align-items: center; gap: 12px; }
[data-breakpoint="compact"] .ga-row { grid-template-columns: 1fr; }
.ga-field { min-height: 44px; max-width: 320px; padding: 8px 14px; border: 1px solid var(--ridrs-line, #24324d);
  border-radius: 12px; background: var(--ridrs-surface, #131c2e); color: var(--ridrs-text, #f2f5fa);
  font: 16px system-ui, sans-serif; }
.ga-field:focus-visible { outline: 3px solid var(--ridrs-focus, #fff); outline-offset: 2px; }
.ga-value { min-width: 90px; font-size: 20px; font-weight: 700; text-align: center; }
.ga-teeth { margin: 0; font-variant-numeric: tabular-nums; }
.ga-notice { padding: 10px 14px; border-radius: 12px; background: var(--ridrs-surface-raised, #1a2540);
  color: var(--ridrs-warn, #ffb62e); }
`;

const MODES: readonly ShiftMode[] = ['manual', 'semi-synchro', 'full-synchro'];

/** The bicycle, kept at once; every change is handed to the next ride right away (ADR 0060). */
const useDocument = userDocument(BICYCLE_DOCUMENT, DEFAULT_BICYCLE);

function useBicycle(ctx: UiContext) {
  const [document, change] = useDocument(ctx);
  const update = (edit: (current: BicycleDocument) => BicycleDocument) =>
    change((current) => {
      const next = edit(current);
      ctx.events.publish(equipmentBicycleChangedEvent, resolveBicycle(next));
      return next;
    });
  return [document, update] as const;
}

/** Whether a ride is under way: a change then applies to the next ride. */
function useRiding(ctx: UiContext): boolean {
  const [riding, setRiding] = useState(false);
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) =>
        setRiding(payload.state === 'running' || payload.state === 'paused'),
      ),
    [ctx],
  );
  return riding;
}

function Stepper({
  name,
  lower,
  raise,
  value,
  onStep,
}: {
  readonly name: string;
  readonly lower: string;
  readonly raise: string;
  readonly value: string;
  readonly onStep: (direction: 1 | -1) => void;
}) {
  return (
    <div className="ga-row">
      <span>{name}</span>
      <div className="pv-row">
        <button type="button" className="pv-icon" aria-label={lower} onClick={() => onStep(-1)}>
          −
        </button>
        <output className="ga-value" aria-label={name}>
          {value}
        </output>
        <button type="button" className="pv-icon" aria-label={raise} onClick={() => onStep(1)}>
          +
        </button>
      </div>
    </div>
  );
}

function GarageView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const [bicycle, update] = useBicycle(ctx);
  const riding = useRiding(ctx);
  const [name, setName] = useState<string>();
  useBack(ctx);
  const spec = specificationOf(bicycle.drivetrain);
  const chainrings = spec.drivetrain.chainrings.teeth;
  const sprockets = spec.drivetrain.cassette.teeth;
  const start = `${chainrings[bicycle.startGear.front - 1]} × ${sprockets[bicycle.startGear.rear - 1]}`;

  return (
    <div className="pv-page">
      <style>{PREVIEW_CSS}</style>
      <style>{CSS}</style>
      <header className="pv-title">
        <span className="pv-glyph" aria-hidden="true" style={{ ...iconStyle(WRENCH), width: 28, height: 28 }} />
        <h1>{text.title}</h1>
      </header>
      <p className="pv-muted">{text.intro}</p>
      {riding ? (
        <p className="ga-notice" role="status">
          {text.riding}
        </p>
      ) : null}

      <section className="pv-section">
        <h2>{text.bicycle}</h2>
        <label className="ga-row">
          <span>{text.name}</span>
          <input
            className="ga-field"
            aria-label={text.name}
            maxLength={40}
            value={name ?? bicycle.name}
            onChange={(event) => {
              setName(event.target.value);
              const kept = event.target.value.trim();
              if (kept !== '') update((b) => ({ ...b, name: kept }));
            }}
          />
        </label>
        <Stepper
          name={text.weight}
          lower={text.lowerWeight}
          raise={text.raiseWeight}
          value={`${localizeNumber(bicycle.mass.toFixed(1), language)} kg`}
          onStep={(d) =>
            update((b) => ({ ...b, mass: Math.min(25, Math.max(5, Math.round((b.mass + 0.5 * d) * 10) / 10)) }))
          }
        />
      </section>

      <section className="pv-section">
        <h2>{text.drivetrain}</h2>
        <div className="pv-card">
          <h3>{spec.name}</h3>
          <p className="ga-teeth pv-muted">{text.chainrings([...chainrings].reverse().join(' / '))}</p>
          <p className="ga-teeth pv-muted">{text.cassette([...sprockets].reverse().join(' · '))}</p>
        </div>
        <div className="pv-row" role="group" aria-label={text.shiftingMode}>
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="pv-chip"
              aria-pressed={bicycle.shiftMode === mode}
              onClick={() => update((b) => ({ ...b, shiftMode: mode }))}
            >
              {text.modes[mode].label}
            </button>
          ))}
        </div>
        <p className="pv-muted">{text.modes[bicycle.shiftMode].about}</p>
      </section>

      <section className="pv-section">
        <h2>{text.startGear}</h2>
        <div className="pv-row" role="group" aria-label={text.startChainring}>
          {chainrings.map((teeth, i) => (
            <button
              key={teeth}
              type="button"
              className="pv-chip"
              aria-pressed={bicycle.startGear.front === i + 1}
              onClick={() => update((b) => ({ ...b, startGear: { ...b.startGear, front: i + 1 } }))}
            >
              {text.teeth(teeth)}
            </button>
          ))}
        </div>
        <Stepper
          name={text.startGear}
          lower={text.easierStart}
          raise={text.harderStart}
          value={start}
          onStep={(d) =>
            update((b) => ({
              ...b,
              startGear: { ...b.startGear, rear: Math.min(sprockets.length, Math.max(1, b.startGear.rear + d)) },
            }))
          }
        />
      </section>
    </div>
  );
}

export const GarageScreen = reactComponent((ctx) => <GarageView ctx={ctx} />);
function GarageActionView({ ctx }: { readonly ctx: UiContext }) {
  return <ActionButton ctx={ctx} screen="garage" label={useMessages(ctx, messages).title} icon={WAREHOUSE} />;
}

export const GarageAction = reactComponent((ctx) => <GarageActionView ctx={ctx} />);
