// SPDX-License-Identifier: AGPL-3.0-or-later

import { trainerErgRequestedEvent, trainerTargetPowerEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { type KeyboardEvent, useEffect, useState } from 'react';
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
 * The ERG toggle: Enter turns ERG on at the default target and off again; it says "On" or "Off",
 * nothing more. The target shows where the gear was (`hud/erg-on`). It only asks
 * (`trainer.erg-requested`); the ERG driver sets the target.
 */
function ErgToggleView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const erg = useTarget(ctx) !== null;
  const [focused, setFocused] = useState(false);
  return (
    <button
      type="button"
      aria-label={text.erg}
      aria-pressed={erg}
      data-testid="widget-erg"
      data-status={erg ? 'available' : 'unavailable'}
      onClick={() => ctx.events.publish(trainerErgRequestedEvent, { change: erg ? 'leave' : 'enter' })}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        pointerEvents: 'auto',
        minWidth: 110,
        padding: '12px 18px',
        borderRadius: 14,
        border: 'none',
        textAlign: 'left',
        background: erg ? 'rgba(10, 70, 90, 0.85)' : 'rgba(16, 20, 24, 0.72)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        // The focus is always clearly visible.
        outline: focused ? '3px solid #ffd60a' : 'none',
        outlineOffset: 2,
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.8 }}>{text.erg}</div>
      <div data-testid="value" style={{ fontSize: 28, fontWeight: 700, minHeight: 53, lineHeight: '53px' }}>
        {erg ? text.on : text.off}
      </div>
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
  const watts = useTarget(ctx);
  const [focused, setFocused] = useState(false);
  const erg = watts !== null;

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
      aria-valuenow={watts}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        pointerEvents: 'auto',
        minWidth: 110,
        padding: '12px 18px',
        borderRadius: 14,
        background: 'rgba(10, 70, 90, 0.85)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        // The focus is always clearly visible.
        outline: focused ? '3px solid #ffd60a' : 'none',
        outlineOffset: 2,
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.8 }}>{text.target}</div>
      <div data-testid="value" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.1 }}>
        {text.watts(watts)}
      </div>
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
