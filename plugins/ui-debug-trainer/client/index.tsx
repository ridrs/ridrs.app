// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DrivetrainGearChangedPayload,
  drivetrainGearChangedEvent,
  type PhysicsState,
  physicsStateEvent,
  type TrainerCommand,
  type TrainerControlChangedPayload,
  trainerCommandEvent,
  trainerControlChangedEvent,
} from '@ridrs/contracts';
import { formatDecimal, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const EN_DASH = '–';

/** Rise over run as a percentage, two decimals: the FTMS resolution is 0.01 %. */
function percent(gradient: number): string {
  return `${formatDecimal(gradient * 100, 2)} %`;
}

function describeControl(control: TrainerControlChangedPayload | undefined): string {
  if (!control) {
    return EN_DASH;
  }
  const mode =
    control.mode === 'erg' && control.targetPower !== undefined
      ? `ERG ${control.targetPower} W`
      : control.mode;
  return `${mode} (${control.control})`;
}

type ModeCommand = Extract<TrainerCommand, { kind: 'target-power' | 'simulation' }>;

function describeCommand(command: ModeCommand | undefined): string {
  if (!command) {
    return EN_DASH;
  }
  if (command.kind === 'target-power') {
    return `target ${command.watts} W`;
  }
  return [
    `grade ${percent(command.gradient)}`,
    `Crr ${formatDecimal(command.crr, 4)}`,
    `CW ${formatDecimal(command.cw, 3)} kg/m`,
    `wind ${formatDecimal(command.windSpeed, 1)} m/s`,
  ].join(' · ');
}

function describeGear(gear: DrivetrainGearChangedPayload | undefined): string {
  if (!gear) {
    return EN_DASH;
  }
  const parts = [`${gear.index} / ${gear.count}`];
  if (gear.front !== undefined && gear.rear !== undefined) {
    parts.push(`${gear.front}×${gear.rear}`);
  }
  if (gear.chainring !== undefined && gear.sprocket !== undefined) {
    parts.push(`${gear.chainring}×${gear.sprocket}`);
  }
  parts.push(`ratio ${formatDecimal(gear.ratio, 2)}`);
  return parts.join(' · ');
}

function describeGradient(state: PhysicsState | undefined): string {
  const load = state?.trainerLoad;
  if (!load) {
    return EN_DASH;
  }
  // What the trainer simulates: with the virtual gear when a gear source is there.
  const trainer = load.virtualGear ? load.resistanceWithVirtualGear : load.resistance;
  return `road ${percent(load.resistance.gradient)} → trainer ${percent(trainer.gradient)}`;
}

/** Where a typed D is text, not the toggle. */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'button') ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * What ridrs tells the trainer, for tuning its feel: the control and the mode, the mode command
 * sent last (the ERG target or the simulation parameters), the virtual gear, and the road's
 * gradient next to the one the trainer simulates. It only reads events and never takes the focus,
 * so it changes no ride control; D hides and shows it.
 */
function TrainerDebugHudView({ ctx }: { readonly ctx: UiContext }) {
  const [visible, setVisible] = useState(true);
  const [control, setControl] = useState<TrainerControlChangedPayload>();
  const [command, setCommand] = useState<ModeCommand>();
  const [gear, setGear] = useState<DrivetrainGearChangedPayload>();
  const [state, setState] = useState<PhysicsState>();

  useEffect(
    () => ctx.events.subscribe(trainerControlChangedEvent, ({ payload }) => setControl(payload)),
    [ctx],
  );
  useEffect(
    () =>
      ctx.events.subscribe(trainerCommandEvent, ({ payload }) => {
        // Requesting control and starting are no load the trainer feels.
        if (payload.command.kind === 'target-power' || payload.command.kind === 'simulation') {
          setCommand(payload.command);
        }
      }),
    [ctx],
  );
  useEffect(
    () => ctx.events.subscribe(drivetrainGearChangedEvent, ({ payload }) => setGear(payload)),
    [ctx],
  );
  useEffect(() => ctx.events.subscribe(physicsStateEvent, ({ payload }) => setState(payload)), [ctx]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key !== 'd' && event.key !== 'D') ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTextEntry(event.target)
      ) {
        return;
      }
      event.preventDefault();
      setVisible((shown) => !shown);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!visible) {
    return null;
  }

  const rows: readonly (readonly [string, string])[] = [
    ['Mode', describeControl(control)],
    ['Command', describeCommand(command)],
    ['Gear', describeGear(gear)],
    ['Gradient', describeGradient(state)],
  ];

  return (
    <section
      data-testid="debug-trainer"
      aria-label="Trainer debug"
      style={{
        position: 'absolute',
        // Below Pause, clear of the widgets in the lower corners.
        top: 72,
        left: 16,
        maxWidth: 'calc(100% - 32px)',
        padding: '8px 12px',
        borderRadius: 10,
        background: 'rgba(16, 20, 24, 0.72)',
        color: '#fff',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        pointerEvents: 'none',
      }}
    >
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0 12px', margin: 0 }}>
        {rows.map(([term, value]) => (
          <div key={term} style={{ display: 'contents' }}>
            <dt style={{ opacity: 0.7 }}>{term}</dt>
            <dd style={{ margin: 0 }}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export const TrainerDebugHud: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<TrainerDebugHudView ctx={ctx} />);
  return () => root.unmount();
};
