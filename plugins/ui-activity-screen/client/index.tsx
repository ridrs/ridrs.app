// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityStateChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, type Ref, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** Explicit stacking order of this screen's layers, bottom to top. */
const Z_LANDSCAPE = 0;
const Z_HUD = 1;
const Z_CONTROLS = 2;
const Z_DIALOG = 3;

/** Other plugins' screens, there or not: the screen only knows their ids. */
const DEBRIEFING = 'debriefing';
const SETTINGS = 'settings';
const DEVICES = 'setup';

/**
 * The screens shown in a dialog over the ride (ADR 0098): the debriefing, and the settings and
 * the devices the debriefing opens. They lead back to the debriefing, not to the ride.
 */
const DIALOGS = [DEBRIEFING, SETTINGS, DEVICES];
const FROM_DEBRIEFING = new Set([SETTINGS, DEVICES]);

const PAUSE = new URL('./assets/icons/pause.svg', import.meta.url).href;
const RESUME = new URL('./assets/icons/play.svg', import.meta.url).href;
const FINISH = new URL('./assets/icons/flag.svg', import.meta.url).href;

/**
 * The ride's buttons: round, side by side at the top left, over the HUD and apart from it. They
 * stay below the window's own buttons, which the Mac app has over the page: as far down as the
 * main screen's page head (`--ridrs-page-top`, 40 px in ui-main-screen, which is not around this
 * screen).
 */
const BUTTON_SIZE = 56;
const BUTTON_TOP = 'var(--ridrs-page-top, 40px)';
const BUTTON_LEFT = 16;
const BUTTON_GAP = 16;

/**
 * How much room a HUD keeps at the bottom, as the custom property `--ridrs-hud-inset-bottom` on
 * the HUD's slot: HUDs place their lower widgets above it. The ride's buttons are not there.
 */
const HUD_INSET_BOTTOM = 16;

/**
 * Drawn like the global actions of the main screen (`.ms-actions [data-action]`) where they stand
 * over a picture: a round glass with a light edge, the icon in the colour of the text.
 */
const CONTROLS_CSS = `
.as-control { display: grid; place-items: center; padding: 0; border: 0;
  background: var(--ridrs-card-quiet); box-shadow: var(--ridrs-edge), var(--ridrs-shadow);
  color: var(--ridrs-text); cursor: pointer; transition: filter var(--ridrs-ease); }
.as-control:hover { filter: brightness(1.25); }
.as-control:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 3px; }
.as-control-icon { width: 24px; height: 24px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
/* A screen in a dialog over the ride (ADR 0098), drawn like the dialogs of the main screen. */
.as-dialog { position: absolute; inset: 0; display: grid; place-items: center; padding: 40px;
  background: rgb(4 8 16 / .66); backdrop-filter: blur(6px); }
.as-dialog[hidden] { display: none; }
.as-dialog-panel { position: relative; display: flex; flex-direction: column; width: min(960px, 100%);
  max-height: 100%; overflow: hidden; border: 1px solid var(--ridrs-line); border-radius: var(--ridrs-radius-lg);
  background: var(--ridrs-bg); box-shadow: var(--ridrs-edge), 0 24px 64px rgb(0 0 0 / .5); }
.as-dialog-panel:focus { outline: none; }
.as-dialog-body { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; overflow: auto; }
.as-dialog-close { position: absolute; top: 16px; right: 16px; z-index: 1; width: 40px; height: 40px;
  padding: 0; border: 0; box-shadow: var(--ridrs-edge); border-radius: 50%; background: var(--ridrs-card-quiet);
  color: var(--ridrs-text); cursor: pointer; }
.as-dialog-close:hover { background: var(--ridrs-surface-raised); }
.as-dialog-close:focus-visible { outline: var(--ridrs-focus-ring); outline-offset: 2px; }
.as-dialog-close::before, .as-dialog-close::after { content: ""; position: absolute; top: 50%; left: 50%;
  width: 16px; height: 2px; border-radius: 1px; background: currentColor; }
.as-dialog-close::before { transform: translate(-50%, -50%) rotate(45deg); }
.as-dialog-close::after { transform: translate(-50%, -50%) rotate(-45deg); }
@media (max-width: 599px) {
  .as-dialog { padding: 0; }
  .as-dialog-panel { width: 100%; height: 100%; border: 0; border-radius: 0; }
}
`;

/**
 * The left edges of the row Pause, the contributed controls, Finish ride, from the left edge,
 * whatever number of controls there is.
 */
function rowLayout(controls: number): { readonly pause: number; readonly controls: number; readonly finish: number } {
  const step = BUTTON_SIZE + BUTTON_GAP;
  return { pause: BUTTON_LEFT, controls: BUTTON_LEFT + step, finish: BUTTON_LEFT + (controls + 1) * step };
}

function controlStyle(left: number): CSSProperties {
  return {
    position: 'absolute',
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: '50%',
    top: BUTTON_TOP,
    left,
    zIndex: Z_CONTROLS,
  };
}

/** A round button that says what it does by its icon, its name and its tooltip. */
function Control({
  label,
  icon,
  left,
  testId,
  onPress,
  buttonRef,
}: {
  readonly label: string;
  readonly icon: string;
  readonly left: number;
  readonly testId: string;
  readonly onPress: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="as-control"
      data-testid={testId}
      aria-label={label}
      title={label}
      style={controlStyle(left)}
      onClick={onPress}
    >
      <span className="as-control-icon" aria-hidden="true" style={{ '--icon': `url("${icon}")` } as CSSProperties} />
    </button>
  );
}

/**
 * The dialog over the ride. While it is open the ride beneath it is inert, so the arrows stay in
 * the dialog (AGENTS.md rule 12). It takes the focus unless the screen in it already took it (the
 * debriefing focuses Save) and gives it back to Finish ride once it closes. The debriefing has its
 * own way back to the ride (Continue ride); the settings and the devices get Close.
 */
function Dialog({
  ctx,
  screen,
  container,
  opener,
}: {
  readonly ctx: UiContext;
  readonly screen: string | undefined;
  readonly container: RefObject<HTMLDivElement | null>;
  readonly opener: RefObject<HTMLButtonElement | null>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const open = screen !== undefined;
  const closable = open && screen !== DEBRIEFING;
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    const element = panel.current;
    if (open && element && !element.contains(element.ownerDocument.activeElement)) {
      element.focus();
    } else if (!open && wasOpen.current && opener.current?.isConnected) {
      opener.current.focus();
    }
    wasOpen.current = open;
  }, [open, opener]);
  return (
    // The backdrop is a pointer's way out of the settings and the devices; keys leave with Back.
    <div
      className="as-dialog"
      role="dialog"
      aria-modal="true"
      hidden={!open}
      data-testid="activity-dialog"
      style={{ zIndex: Z_DIALOG }}
      onClick={(event) => {
        if (closable && event.target === event.currentTarget) ctx.leave();
      }}
    >
      <div ref={panel} className="as-dialog-panel" tabIndex={-1}>
        {closable ? (
          <button type="button" className="as-dialog-close" aria-label="Close" onClick={() => ctx.leave()} />
        ) : null}
        <div ref={container} className="as-dialog-body" />
      </div>
    </div>
  );
}

function ActivityScreenView({ ctx }: { readonly ctx: UiContext }) {
  const landscape = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const finish = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  // How many controls other plugins add between Pause and Finish ride: Finish ride comes after all.
  const [controlCount, setControlCount] = useState(0);
  const row = rowLayout(controlCount);
  const [paused, setPaused] = useState(false);
  // The landscape of the ride's world; null for a free ride, undefined until the state is known.
  const [world, setWorld] = useState<string | null>();
  const dialog = useRef<HTMLDivElement>(null);
  // The screen in the dialog over the ride, if one is open.
  const [over, setOver] = useState<string>();
  const state = useRef<string>(undefined);
  // Finish ride paused a running ride for its debriefing: going back to the ride resumes it.
  const pausedForDebriefing = useRef(false);

  // Back never ends a ride by accident: it offers Finish ride, which Enter then confirms.
  useEffect(() => ctx.onBack(() => finish.current?.focus()), [ctx]);

  // The screen only offers extension points; it never knows who contributes to them. The ride's
  // world names its landscape; a free ride shows every landscape there is.
  useEffect(() => {
    if (!hud.current) {
      return undefined;
    }
    return ctx.slot('activity/hud', hud.current);
  }, [ctx]);

  useEffect(() => {
    const container = controls.current;
    if (!container) {
      return undefined;
    }
    const count = () => setControlCount(container.children.length);
    const observer = new MutationObserver(count);
    observer.observe(container, { childList: true });
    const release = ctx.slot('activity/control', container);
    count();
    return () => {
      observer.disconnect();
      release();
    };
  }, [ctx]);

  useEffect(() => {
    if (!landscape.current || world === undefined) {
      return undefined;
    }
    return ctx.slot('activity/landscape', landscape.current, world ? { contribution: world } : undefined);
  }, [ctx, world]);

  // The debriefing, and the settings and the devices it opens, float over the ride (ADR 0098).
  // At commit, not after paint: Finish ride may be pressed before passive effects ran.
  useLayoutEffect(
    () =>
      dialog.current
        ? ctx.outlet(dialog.current, { screens: [], dialog: { container: dialog.current, screens: DIALOGS } })
        : undefined,
    [ctx],
  );

  // Leaving the settings or the devices leads back to the debriefing; leaving the debriefing
  // leads back to the ride, which goes on if Finish ride paused it. A ride that is ended has no
  // way back: it stays in its debriefing.
  useLayoutEffect(() => {
    let previous: string | undefined;
    let fromDebriefing = false;
    return ctx.onNavigated((screen, page) => {
      const shown = screen !== page ? screen : undefined;
      const before = previous;
      previous = shown;
      setOver(shown);
      if (shown === DEBRIEFING) {
        fromDebriefing = true;
        return;
      }
      if (shown !== undefined) {
        fromDebriefing &&= FROM_DEBRIEFING.has(shown);
        return;
      }
      if (page !== 'activity') {
        return;
      }
      const ended = state.current === 'finished' && ctx.hasScreen(DEBRIEFING);
      if (ended || (fromDebriefing && before !== undefined && FROM_DEBRIEFING.has(before))) {
        // After this navigation has been told to everyone.
        queueMicrotask(() => ctx.navigate(DEBRIEFING));
        return;
      }
      if (before === DEBRIEFING && pausedForDebriefing.current && state.current === 'paused') {
        ctx.events.publish(activityResumeRequestedEvent, {});
      }
      pausedForDebriefing.current = false;
      fromDebriefing = false;
    });
  }, [ctx]);

  // Finish ride stops the ride where it is and asks what becomes of it: the debriefing ends it
  // (Save or Delete) or leads back to it. Without a debriefing the ride ends at once.
  const onFinish = () => {
    if (!ctx.hasScreen(DEBRIEFING)) {
      ctx.events.publish(activityFinishRequestedEvent, {});
      return;
    }
    if (state.current === 'running') {
      pausedForDebriefing.current = true;
      ctx.events.publish(activityPauseRequestedEvent, {});
    }
    ctx.navigate(DEBRIEFING);
  };

  // At commit as well: Finish ride needs to know whether the ride runs.
  useLayoutEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        state.current = payload.state;
        // A paused ride stays here (ADR 0056); a finished one goes to its debriefing, where the
        // rider saves or deletes it, or back to the main screen without one.
        if (payload.state === 'paused' || payload.state === 'running') {
          setPaused(payload.state === 'paused');
          setWorld(payload.world?.landscape ?? null);
        } else if (payload.state === 'finished' && ctx.hasScreen(DEBRIEFING)) {
          ctx.navigate(DEBRIEFING);
        } else {
          ctx.navigate('main');
        }
      }),
    [ctx],
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <style>{CONTROLS_CSS}</style>
      {/*
        The ride, inert beneath a dialog and hidden from assistive technology. Positioned without
        a z-index, so its layers stay in the one stacking context of the screen.
      */}
      <div style={{ position: 'absolute', inset: 0 }} inert={over !== undefined} aria-hidden={over !== undefined || undefined}>
      {paused ? (
        <div
          data-testid="ride-paused"
          style={{
            position: 'absolute',
            top: '40%',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: Z_CONTROLS,
            padding: '12px 28px',
            borderRadius: 'var(--ridrs-radius-lg)',
            background: 'var(--ridrs-card)',
            boxShadow: 'var(--ridrs-edge), var(--ridrs-shadow)',
            color: 'var(--ridrs-text)',
            fontFamily: 'var(--ridrs-font-display)',
            fontStyle: 'italic',
            textTransform: 'uppercase',
            letterSpacing: '.08em',
            fontSize: 'var(--ridrs-size-hero)',
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          Paused
        </div>
      ) : null}
      {/*
        Direct children like the HUD: one stacking context; Pause (or Resume), the controls of
        other plugins (`activity/control`, such as ERG) and Finish ride side by side at the top
        left. They come first in reading order: the first arrow of a ride focuses Pause, not a
        control that changes the ride.
      */}
      {paused ? (
        <Control
          label="Resume"
          icon={RESUME}
          left={row.pause}
          testId="resume-ride"
          onPress={() => ctx.events.publish(activityResumeRequestedEvent, {})}
        />
      ) : (
        <Control
          label="Pause"
          icon={PAUSE}
          left={row.pause}
          testId="pause-ride"
          onPress={() => ctx.events.publish(activityPauseRequestedEvent, {})}
        />
      )}
      <div
        ref={controls}
        data-testid="slot-activity-control"
        style={{
          position: 'absolute',
          top: BUTTON_TOP,
          left: row.controls,
          height: BUTTON_SIZE,
          display: 'flex',
          gap: BUTTON_GAP,
          zIndex: Z_CONTROLS,
        }}
      />
      <Control
        buttonRef={finish}
        label="Finish ride"
        icon={FINISH}
        left={row.finish}
        testId="finish-ride"
        onPress={onFinish}
      />
      <div
        data-testid="slot-activity-landscape"
        ref={landscape}
        style={{ position: 'absolute', inset: 0, zIndex: Z_LANDSCAPE }}
      />
      <div
        data-testid="slot-activity-hud"
        ref={hud}
        style={
          {
            position: 'absolute',
            inset: 0,
            zIndex: Z_HUD,
            pointerEvents: 'none',
            '--ridrs-hud-inset-bottom': `${HUD_INSET_BOTTOM}px`,
          } as CSSProperties
        }
      />
      </div>
      <Dialog ctx={ctx} screen={over} container={dialog} opener={finish} />
    </div>
  );
}

export const ActivityScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ActivityScreenView ctx={ctx} />);
  return () => root.unmount();
};
