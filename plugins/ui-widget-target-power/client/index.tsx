// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  trainerErgRequestedEvent,
  trainerTargetPowerEvent,
  type WorkoutHaltChangedPayload,
  workoutHaltChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';

/** + and - change the target without the focus: `=` is + without Shift on many keyboards. */
const PLUS_MINUS: Readonly<Record<string, 'up' | 'down'>> = { '+': 'up', '=': 'up', '-': 'down' };

/** Where a typed + or - is text, not a ride control. */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'button') ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** The target in force; `null` without ERG. */
function useTarget(ctx: UiContext): number | null {
  const [watts, setWatts] = useState<number | null>(null);
  useEffect(
    () => ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => setWatts(payload.watts)),
    [ctx],
  );
  return watts;
}

/**
 * The workout's halt (ADR 0113), while it is not running, and the target the rider goes back to:
 * the last one before the halt.
 */
function useHalt(ctx: UiContext): {
  halt?: WorkoutHaltChangedPayload;
  resumeWatts?: number;
  ceiling?: number;
} {
  const [halt, setHalt] = useState<WorkoutHaltChangedPayload>();
  const [ceiling, setCeiling] = useState<number>();
  const [resumeWatts, setResumeWatts] = useState<number>();
  const halting = useRef(false);
  useEffect(() => {
    const stopTarget = ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => {
      if (!halting.current && payload.watts !== null) {
        setResumeWatts(payload.watts);
      }
    });
    const stopHalt = ctx.events.subscribe(workoutHaltChangedEvent, ({ payload }) => {
      halting.current = payload.state !== 'running';
      setHalt(halting.current ? payload : undefined);
      setCeiling(payload.ceiling);
    });
    return () => {
      stopTarget();
      stopHalt();
    };
  }, [ctx]);
  return {
    ...(halt ? { halt } : {}),
    ...(resumeWatts === undefined ? {} : { resumeWatts }),
    ...(ceiling === undefined ? {} : { ceiling }),
  };
}

/**
 * The ERG toggle, a round control of the activity screen between Pause and Finish ride
 * (`activity/control`), drawn like them: a round glass with a light edge. Enter turns ERG on at
 * the default target and off again; it says "On" or "Off", nothing more, and shows the state in
 * the info colour while on. The target shows where the gear was (`hud/erg-on`). It only asks
 * (`trainer.erg-requested`); the ERG driver sets the target.
 */
function ErgToggleView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const target = useTarget(ctx);
  const { halt } = useHalt(ctx);
  const erg = target !== null || halt !== undefined;
  return (
    <button
      type="button"
      aria-label={text.erg}
      aria-pressed={erg}
      title={text.erg}
      data-testid="widget-erg"
      data-status={erg ? 'available' : 'unavailable'}
      onClick={() => ctx.events.publish(trainerErgRequestedEvent, { change: erg ? 'leave' : 'enter' })}
      style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        display: 'grid',
        placeContent: 'center',
        gap: 1,
        padding: 0,
        border: 0,
        // Like Pause and Finish: the card. On is volt, never cyan (cyan is the focus).
        background: 'var(--ridrs-card-quiet)',
        boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
        color: erg ? 'var(--ridrs-accent)' : 'var(--ridrs-text)',
        fontFamily: 'var(--ridrs-font-text)',
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '.06em' }}>{text.erg}</span>
      <span data-testid="value" style={{ fontSize: 'var(--ridrs-size-label)', fontWeight: 500 }}>
        {erg ? text.on : text.off}
      </span>
    </button>
  );
}

/**
 * The ERG target, in the place of the gear while ERG is on. Keyboard first (AGENTS.md rule 12):
 * ↑ and ↓ change it by 5 W while it has the focus (← and → still move the focus), + and -
 * anywhere on the screen; Back leaves ERG while it has the focus.
 */
function TargetPowerView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const target = useTarget(ctx);
  const { halt, resumeWatts, ceiling } = useHalt(ctx);
  const [focused, setFocused] = useState(false);
  // While the workout halts, the trainer rides the route: the widget shows the target the rider
  // goes back to, and how.
  const watts = halt ? (target ?? resumeWatts ?? null) : target;
  const erg = watts !== null || halt !== undefined;

  useEffect(
    () =>
      erg && focused
        ? ctx.onBack(() => ctx.events.publish(trainerErgRequestedEvent, { change: 'leave' }))
        : undefined,
    [ctx, erg, focused],
  );

  useEffect(() => {
    if (!erg) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const change = PLUS_MINUS[event.key];
      if (
        !change ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTextEntry(event.target)
      ) {
        return;
      }
      event.preventDefault();
      ctx.events.publish(trainerErgRequestedEvent, { change });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ctx, erg]);

  if (!erg) {
    return null;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    // The arrows change the target here instead of moving the focus.
    event.preventDefault();
    ctx.events.publish(trainerErgRequestedEvent, { change: event.key === 'ArrowUp' ? 'up' : 'down' });
  };

  return (
    <section
      data-testid="widget-target-power"
      data-status="available"
      role="spinbutton"
      tabIndex={0}
      aria-label={text.targetPower}
      aria-valuenow={watts ?? undefined}
      {...(halt ? { 'data-halt': halt.state } : {})}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        pointerEvents: 'auto',
        minWidth: 110,
        padding: '12px 18px',
        borderRadius: 'var(--ridrs-radius)',
        background: 'var(--ridrs-card)',
        boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
        color: 'var(--ridrs-text)',
        fontFamily: 'var(--ridrs-font-text)',
      }}
    >
      <div data-testid="label" style={{ fontFamily: 'var(--ridrs-font-mono)', fontSize: 'var(--ridrs-size-label)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ridrs-info)' }}>
        {halt?.state === 'halted'
          ? text.halted
          : halt?.state === 'countdown'
            ? text.goingOn(halt.secondsLeft ?? 5)
            : text.target}
      </div>
      <div data-testid="value" style={{ fontSize: 44, fontWeight: 500, lineHeight: 1.1, opacity: halt?.state === 'halted' ? 0.6 : 1 }}>
        {watts === null ? '–' : text.watts(watts)}
      </div>
      {ceiling !== undefined && (
        <div data-testid="ceiling" style={{ fontSize: 13, opacity: 0.8 }}>
          {text.ceiling(ceiling)}
        </div>
      )}
      {focused && (
        <div data-testid="keys" style={{ fontSize: 13, opacity: 0.8 }}>
          {text.keys}
        </div>
      )}
    </section>
  );
}

export const ErgToggle: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ErgToggleView ctx={ctx} />);
  return () => root.unmount();
};

export const TargetPowerWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<TargetPowerView ctx={ctx} />);
  return () => root.unmount();
};
