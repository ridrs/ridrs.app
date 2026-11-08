// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DrivetrainGearChangedPayload,
  drivetrainGearChangedEvent,
  drivetrainShiftRequestedEvent,
  trainerTargetPowerEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';

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

/** Teeth: the gear of a bicycle's drivetrain (ADR 0060), a pair of focusable values. */
function Teeth({
  label,
  value,
  onShift,
}: {
  readonly label: string;
  readonly value: number;
  readonly onShift: (change: 'up' | 'down') => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <span
      role="spinbutton"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={value}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
          return;
        }
        event.preventDefault();
        onShift(event.key === 'ArrowUp' ? 'up' : 'down');
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        padding: '0 4px',
        borderRadius: 8,
        // The focus is always clearly visible.
        outline: focused ? '3px solid #ffd60a' : 'none',
        outlineOffset: 2,
      }}
    >
      {value}
    </span>
  );
}

/**
 * The virtual gear: "12" of 24; an en dash until a gear source names one. With a bicycle's
 * drivetrain (ADR 0060) the gear large as its positions, front × rear, "1×1" to "2×12", and the
 * chainring and the sprocket below, "50 × 17", each focusable: ↑ ↓ on the chainring shift
 * the front, on the sprocket the rear. Keyboard first
 * (AGENTS.md rule 12): once there is a gear it takes the focus, and ↑ shifts one gear harder and
 * ↓ one easier while it has it (← and → still move the focus); + and - shift anywhere on the
 * screen, except in ERG, where they are the target's. It only asks (`drivetrain.shift-requested`).
 */
function VirtualGearWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
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
  const teeth =
    gear?.chainring !== undefined &&
    gear.sprocket !== undefined &&
    gear.front !== undefined &&
    gear.rear !== undefined
      ? { chainring: gear.chainring, sprocket: gear.sprocket, front: gear.front, rear: gear.rear }
      : undefined;
  const shiftOn = (derailleur: 'front' | 'rear') => (change: 'up' | 'down') =>
    ctx.events.publish(drivetrainShiftRequestedEvent, { change, derailleur });
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

  if (teeth) {
    return (
      <section
        data-testid="widget-virtual-gear"
        data-status="available"
        aria-label={text.gear}
        style={{
          pointerEvents: 'auto',
          minWidth: 110,
          padding: '12px 18px',
          borderRadius: 14,
          background: 'rgba(16, 20, 24, 0.72)',
          color: '#fff',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 14, opacity: 0.8 }}>{text.gear}</div>
        <div data-testid="value" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.1 }}>
          {`${teeth.front}×${teeth.rear}`}
        </div>
        <div data-testid="teeth" style={{ fontSize: 18, fontWeight: 600, opacity: 0.9 }}>
          <Teeth label={text.chainring} value={teeth.chainring} onShift={shiftOn('front')} />
          {' × '}
          <Teeth label={text.sprocket} value={teeth.sprocket} onShift={shiftOn('rear')} />
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="widget-virtual-gear"
      data-status={gear ? 'available' : 'unavailable'}
      {...(gear
        ? {
            role: 'spinbutton',
            tabIndex: 0,
            'aria-label': text.gear,
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
      <div style={{ fontSize: 14, opacity: 0.8 }}>{text.gear}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {gear ? String(gear.index) : EN_DASH}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          {gear ? text.of(gear.count) : ''}
        </span>
      </div>
      {focused && (
        <div data-testid="keys" style={{ fontSize: 13, opacity: 0.8 }}>
          {text.keys}
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
