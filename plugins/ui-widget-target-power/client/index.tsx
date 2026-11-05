// SPDX-License-Identifier: AGPL-3.0-or-later

import { trainerErgRequestedEvent, trainerTargetPowerEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The ERG target: "ERG 150 W" while ERG holds a target, nothing otherwise. Keyboard first
 * (AGENTS.md rule 12): Enter starts ERG, ↑ and ↓ change the target while the widget has the focus,
 * Back leaves ERG. The widget only asks (`trainer.erg-requested`); the ERG driver sets the target.
 */
function TargetPowerWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [watts, setWatts] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(
    () => ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => setWatts(payload.watts)),
    [ctx],
  );

  const erg = watts !== null;
  // Back leaves ERG only while the widget has the focus; otherwise the screen's Back holds.
  useEffect(
    () =>
      erg && focused
        ? ctx.onBack(() => ctx.events.publish(trainerErgRequestedEvent, { change: 'leave' }))
        : undefined,
    [ctx, erg, focused],
  );

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
      aria-label="Target power"
      data-testid="widget-target-power"
      data-status={erg ? 'available' : 'unavailable'}
      onClick={() => {
        if (!erg) {
          ctx.events.publish(trainerErgRequestedEvent, { change: 'enter' });
        }
      }}
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
        background: 'rgba(16, 20, 24, 0.72)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        // The focus is always clearly visible.
        outline: focused ? '3px solid #ffd60a' : 'none',
        outlineOffset: 2,
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.8 }}>Target power</div>
      <div data-testid="value" style={{ fontSize: 44, fontWeight: 700, minHeight: 53 }}>
        {erg ? `ERG ${watts} W` : ''}
      </div>
    </button>
  );
}

export const TargetPowerWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<TargetPowerWidgetView ctx={ctx} />);
  return () => root.unmount();
};
