// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BINDABLE_CONTROLLER_BUTTONS,
  type BindableControllerButton,
  bindControllerButton,
  CONTROLLER_BINDINGS_KEY,
  CONTROLLER_COMMANDS,
  type ControllerBindings,
  type ControllerButton,
  type ControllerCommand,
  controllerBindingsSetService,
  controllerBindingsState,
  controllerButtonsChangedEvent,
  DEFAULT_CONTROLLER_BINDINGS,
} from '@ridrs/contracts';
import { CONTROLLER_BUTTON_EVENT, type ControllerButtonEventDetail, type UiContext } from '@ridrs/ui-sdk';
import { useMessages, useStateEntries } from '@ridrs/ui-sdk/react';
import { type CSSProperties, type MutableRefObject, useEffect, useState } from 'react';
import { messages } from './i18n/index.ts';

/** The face of each button, as the controller shows it. */
const FACES: Record<ControllerButton, string> = {
  left: '←',
  up: '↑',
  right: '→',
  down: '↓',
  a: 'A',
  b: 'B',
  y: 'Y',
  z: 'Z',
  'shift-up-left': '+',
  'shift-down-left': '−',
  'power-up-left': '⚡',
  'on-off-left': '⏻',
  'shift-up-right': '+',
  'shift-down-right': '−',
  'power-up-right': '⚡',
  'on-off-right': '⏻',
};

/** The buttons that keep their ride functions, as pairs of the left and the right controller. */
const FIXED: readonly {
  readonly function: 'shiftUp' | 'shiftDown' | 'powerUp';
  readonly buttons: readonly ControllerButton[];
}[] = [
  { function: 'shiftUp', buttons: ['shift-up-left', 'shift-up-right'] },
  { function: 'shiftDown', buttons: ['shift-down-left', 'shift-down-right'] },
  { function: 'powerUp', buttons: ['power-up-left', 'power-up-right'] },
];

const isBindable = (button: ControllerButton): button is BindableControllerButton =>
  (BINDABLE_CONTROLLER_BUTTONS as readonly string[]).includes(button);

const CAP: CSSProperties = {
  display: 'inline-grid',
  placeItems: 'center',
  minWidth: 34,
  height: 34,
  padding: '0 8px',
  borderRadius: 17,
  background: 'var(--ridrs-surface-raised)',
  boxShadow: 'var(--ridrs-edge)',
  font: '600 15px var(--ridrs-font-text)',
};

const CAP_HELD: CSSProperties = { ...CAP, background: 'var(--ridrs-accent)', color: 'var(--ridrs-accent-text)', boxShadow: 'none' };

/** A button of the controller as a round key cap, lit while it is held. */
function Cap({ button, held, label }: { readonly button: ControllerButton; readonly held?: boolean; readonly label: string }) {
  return (
    <span role="img" aria-label={label} data-button={button} data-held={held || undefined} style={held ? CAP_HELD : CAP}>
      {FACES[button]}
    </span>
  );
}

const TABLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(160px, 1fr) minmax(200px, 260px)',
  gap: '6px 16px',
  alignItems: 'center',
  maxWidth: 560,
};

const SLOT: CSSProperties = { justifyContent: 'space-between', width: '100%' };

/** The buttons held on any controller now, for the rider to see that it works. */
function useHeld(ctx: UiContext): ReadonlySet<ControllerButton> {
  const [held, setHeld] = useState<ReadonlyMap<string, readonly ControllerButton[]>>(new Map());
  useEffect(
    () =>
      ctx.events.subscribe(controllerButtonsChangedEvent, ({ payload }) =>
        setHeld((before) => new Map(before).set(payload.deviceId, payload.buttons)),
      ),
    [ctx],
  );
  return new Set([...held.values()].flat());
}

/**
 * The controller's bindings as games show them (ADR 0098): one row per command with the button
 * it is on. Choosing a row waits for the next button pressed on the controller and puts the
 * command on it; a command that had that button gets the old one in exchange. The buttons that
 * shift gears and set the ERG target are listed below, fixed.
 */
export function ControllerTab({
  ctx,
  backRef,
}: {
  readonly ctx: UiContext;
  /** Where the settings ask this tab first what Back means. */
  readonly backRef: MutableRefObject<(() => boolean) | undefined>;
}) {
  const text = useMessages(ctx, messages);
  const kept = useStateEntries(ctx, controllerBindingsState).get(CONTROLLER_BINDINGS_KEY);
  const bindings = kept ?? DEFAULT_CONTROLLER_BINDINGS;
  const held = useHeld(ctx);
  /** The command waiting for its button. */
  const [waiting, setWaiting] = useState<ControllerCommand>();
  /** What the last change did, read out once. */
  const [notice, setNotice] = useState<string>();

  const save = (next: ControllerBindings) =>
    ctx
      .call(controllerBindingsSetService, { bindings: next })
      .catch((error: unknown) => ctx.logger.warn(`Could not change the controller bindings: ${String(error)}`));

  // While a command waits, the next button pressed is its button, not a key.
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const document = globalThis.document;
    const take = (event: Event) => {
      const { button } = (event as CustomEvent<ControllerButtonEventDetail>).detail;
      event.preventDefault();
      if (!isBindable(button)) {
        setNotice(text.controller.notBindable(FACES[button]));
        return;
      }
      const next = bindControllerButton(bindings, waiting, button);
      const swapped = CONTROLLER_COMMANDS.find((c) => c !== waiting && next[c] !== bindings[c]);
      setNotice(
        swapped
          ? text.controller.swapped(text.controller.commands[waiting], FACES[button], text.controller.commands[swapped], FACES[next[swapped]])
          : text.controller.bound(text.controller.commands[waiting], FACES[button]),
      );
      setWaiting(undefined);
      void save(next);
    };
    document.addEventListener(CONTROLLER_BUTTON_EVENT, take);
    return () => document.removeEventListener(CONTROLLER_BUTTON_EVENT, take);
  });

  // Back cancels the waiting, as Escape does in a game's menu.
  backRef.current = () => {
    if (!waiting) return false;
    setWaiting(undefined);
    return true;
  };
  useEffect(() => () => (backRef.current = undefined), [backRef]);

  const changed = CONTROLLER_COMMANDS.some((c) => bindings[c] !== DEFAULT_CONTROLLER_BINDINGS[c]);

  return (
    <>
      <section className="pv-section" aria-labelledby="controller-navigation">
        <h2 id="controller-navigation">{text.controller.navigation}</h2>
        <p className="pv-muted">{text.controller.intro}</p>
        <div style={TABLE} role="table" aria-label={text.controller.navigation}>
          <div role="row" style={{ display: 'contents' }}>
            <span role="columnheader" className="pv-muted">
              {text.controller.command}
            </span>
            <span role="columnheader" className="pv-muted">
              {text.controller.button}
            </span>
          </div>
          {CONTROLLER_COMMANDS.map((command) => {
            const name = text.controller.commands[command];
            const button = bindings[command];
            const isWaiting = waiting === command;
            return (
              <div role="row" key={command} style={{ display: 'contents' }} data-command={command}>
                <span role="rowheader">{name}</span>
                <span role="cell">
                  <button
                    type="button"
                    className="pv-button"
                    style={SLOT}
                    aria-label={isWaiting ? text.controller.waitingFor(name) : text.controller.slot(name, text.controller.buttonNames[button])}
                    aria-pressed={isWaiting}
                    onClick={() => {
                      setNotice(undefined);
                      setWaiting(isWaiting ? undefined : command);
                    }}
                  >
                    {isWaiting ? (
                      <span className="pv-muted">{text.controller.pressButton}</span>
                    ) : (
                      <Cap button={button} held={held.has(button)} label={text.controller.buttonNames[button]} />
                    )}
                    <span aria-hidden className="pv-muted" style={{ fontSize: 12 }}>
                      {isWaiting ? text.controller.cancelHint : text.controller.change}
                    </span>
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        <p className="pv-muted" role="status" data-testid="controller-notice">
          {notice ?? ''}
        </p>
        <div className="pv-row">
          <button
            type="button"
            className="pv-button"
            disabled={!changed}
            onClick={() => {
              setWaiting(undefined);
              setNotice(text.controller.resetDone);
              void save(DEFAULT_CONTROLLER_BINDINGS);
            }}
          >
            {text.controller.reset}
          </button>
        </div>
      </section>
      <section className="pv-section" aria-labelledby="controller-ride">
        <h2 id="controller-ride">{text.controller.ride}</h2>
        <p className="pv-muted">{text.controller.rideIntro}</p>
        <div style={TABLE} role="table" aria-label={text.controller.ride}>
          {FIXED.map((row) => (
            <div role="row" key={row.function} style={{ display: 'contents' }}>
              <span role="rowheader">{text.controller.fixed[row.function]}</span>
              <span role="cell" className="pv-row" style={{ gap: 6 }}>
                {row.buttons.map((button) => (
                  <Cap key={button} button={button} held={held.has(button)} label={text.controller.buttonNames[button]} />
                ))}
                <span className="pv-muted" style={{ fontSize: 12 }}>
                  {text.controller.fixedHint}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
