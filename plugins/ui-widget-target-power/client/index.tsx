// SPDX-License-Identifier: AGPL-3.0-or-later

import { trainerErgRequestedEvent, trainerTargetPowerEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

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

/**
 * The ERG button: Enter turns ERG on at the default target and off again; it shows "150 W" or
 * "Off". Keyboard first (AGENTS.md rule 12): in ERG, ↑ and ↓ change the target while it has the
 * focus (← and → still move the focus), + and - anywhere on the screen; Back leaves ERG while it
 * has the focus. The button only asks (`trainer.erg-requested`); the ERG driver sets the target.
 */
function TargetPowerWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [watts, setWatts] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(
    () => ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => setWatts(payload.watts)),
    [ctx],
  );

  const erg = watts !== null;
  // Back leaves ERG only while the button has the focus; otherwise the screen's Back holds.
  useEffect(
    () =>
      erg && focused
        ? ctx.onBack(() => ctx.events.publish(trainerErgRequestedEvent, { change: 'leave' }))
        : undefined,
    [ctx, erg, focused],
  );

  // In ERG, + and - are the target's, wherever the focus is; otherwise they shift the gear.
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

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!erg || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    // The arrows change the target here instead of moving the focus.
    event.preventDefault();
    ctx.events.publish(trainerErgRequestedEvent, {
      change: event.key === 'ArrowUp' ? 'up' : 'down',
    });
  };

  return (
    <button
      type="button"
      aria-label="ERG"
      aria-pressed={erg}
      data-testid="widget-target-power"
      data-status={erg ? 'available' : 'unavailable'}
      onClick={() => ctx.events.publish(trainerErgRequestedEvent, { change: erg ? 'leave' : 'enter' })}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        pointerEvents: 'auto',
        minWidth: 140,
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
      <div style={{ fontSize: 14, opacity: 0.8 }}>ERG</div>
      <div
        data-testid="value"
        style={{ fontSize: erg ? 44 : 28, fontWeight: 700, minHeight: 53, lineHeight: '53px' }}
      >
        {erg ? `${watts} W` : 'Off'}
      </div>
      {focused && erg && (
        <div data-testid="keys" style={{ fontSize: 13, opacity: 0.8 }}>
          ↑ ↓ target
        </div>
      )}
    </button>
  );
}

export const TargetPowerWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<TargetPowerWidgetView ctx={ctx} />);
  return () => root.unmount();
};
