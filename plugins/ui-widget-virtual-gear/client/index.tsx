// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DrivetrainGearChangedPayload,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  trainerTargetPowerEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const EN_DASH = '–';

/** + and - shift without the focus: `=` is + without Shift on many keyboards. */
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
 * The virtual gear: "12" of 24; an en dash until a gear source names one. Keyboard first
 * (AGENTS.md rule 12): once there is a gear it takes the focus, and ↑ shifts one gear harder and
 * ↓ one easier while it has it (← and → still move the focus); + and - shift anywhere on the
 * screen, except in ERG, where they are the target's. It only asks (`drivetrain.shift-requested`).
 */
function VirtualGearWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [gear, setGear] = useState<DrivetrainGearChangedPayload>();
  const [erg, setErg] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(
    () => ctx.events.subscribe(drivetrainGearChangedEvent, ({ payload }) => setGear(payload)),
    [ctx],
  );
  useEffect(
    () =>
      ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => setErg(payload.watts !== null)),
    [ctx],
  );

  const shifts = gear !== undefined;
  useEffect(() => {
    if (!shifts || erg) {
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
      ctx.events.publish(drivetrainShiftRequestedEvent, { change });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ctx, shifts, erg]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    // The arrows shift here instead of moving the focus.
    event.preventDefault();
    ctx.events.publish(drivetrainShiftRequestedEvent, {
      change: event.key === 'ArrowUp' ? 'up' : 'down',
    });
  };

  return (
    <section
      data-testid="widget-virtual-gear"
      data-status={gear ? 'available' : 'unavailable'}
      {...(gear
        ? {
            role: 'spinbutton',
            tabIndex: 0,
            'aria-label': 'Gear',
            'aria-valuenow': gear.index,
            'aria-valuemin': 1,
            'aria-valuemax': gear.count,
            onKeyDown,
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
          }
        : {})}
      style={{
        pointerEvents: 'auto',
        minWidth: 110,
        padding: '12px 18px',
        borderRadius: 14,
        background: 'rgba(16, 20, 24, 0.72)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        // The focus is always clearly visible.
        outline: focused ? '3px solid #ffd60a' : 'none',
        outlineOffset: 2,
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.8 }}>Gear</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {gear ? String(gear.index) : EN_DASH}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          {gear ? `/ ${gear.count}` : ''}
        </span>
      </div>
      {focused && (
        <div data-testid="keys" style={{ fontSize: 13, opacity: 0.8 }}>
          ↑ ↓ shift
        </div>
      )}
    </section>
  );
}

export const VirtualGearWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<VirtualGearWidgetView ctx={ctx} />);
  return () => root.unmount();
};
