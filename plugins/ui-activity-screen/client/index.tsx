// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityStateChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, type Ref, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** Explicit stacking order of this screen's layers, bottom to top. */
const Z_LANDSCAPE = 0;
const Z_HUD = 1;
const Z_CONTROLS = 2;

/** Another plugin's screen, there or not: the screen only knows its id. */
const DEBRIEFING = 'debriefing';

const PAUSE = new URL('./assets/icons/pause.svg', import.meta.url).href;
const RESUME = new URL('./assets/icons/play.svg', import.meta.url).href;
const FINISH = new URL('./assets/icons/flag.svg', import.meta.url).href;

/** The ride's buttons: round, side by side at the bottom centre. */
const BUTTON_SIZE = 56;
const BUTTON_BOTTOM = 24;
const BUTTON_GAP = 16;

/**
 * How much of the bottom a HUD keeps free for the ride's buttons, as the custom property
 * `--ridrs-hud-inset-bottom` on the HUD's slot: HUDs place their lower widgets above it.
 */
const HUD_INSET_BOTTOM = BUTTON_BOTTOM + BUTTON_SIZE + 16;

/**
 * Drawn like the global actions of the main screen (`.ms-actions [data-action]`) where they stand
 * over a picture: a round glass with a light edge, the icon in the colour of the text.
 */
const CONTROLS_CSS = `
.as-control { display: grid; place-items: center; padding: 0;
  border: 1px solid rgb(255 255 255 / .14); background: rgb(11 18 32 / .55);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); color: #f2f5fa; cursor: pointer;
  box-shadow: 0 6px 18px rgb(0 0 0 / .3); }
.as-control:hover { background: rgb(26 37 64 / .75); }
.as-control:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
.as-control-icon { width: 24px; height: 24px; background: currentColor;
  mask: var(--icon) center / contain no-repeat; -webkit-mask: var(--icon) center / contain no-repeat; }
`;

function controlStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: '50%',
    bottom: BUTTON_BOTTOM,
    left:
      side === 'left'
        ? `calc(50% - ${BUTTON_SIZE + BUTTON_GAP / 2}px)`
        : `calc(50% + ${BUTTON_GAP / 2}px)`,
    zIndex: Z_CONTROLS,
  };
}

/** A round button that says what it does by its icon, its name and its tooltip. */
function Control({
  label,
  icon,
  side,
  testId,
  onPress,
  buttonRef,
}: {
  readonly label: string;
  readonly icon: string;
  readonly side: 'left' | 'right';
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
      style={controlStyle(side)}
      onClick={onPress}
    >
      <span className="as-control-icon" aria-hidden="true" style={{ '--icon': `url("${icon}")` } as CSSProperties} />
    </button>
  );
}

function ActivityScreenView({ ctx }: { readonly ctx: UiContext }) {
  const landscape = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const finish = useRef<HTMLButtonElement>(null);
  const [paused, setPaused] = useState(false);
  // The landscape of the ride's world; null for a free ride, undefined until the state is known.
  const [world, setWorld] = useState<string | null>();

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
    if (!landscape.current || world === undefined) {
      return undefined;
    }
    return ctx.slot('activity/landscape', landscape.current, world ? { contribution: world } : undefined);
  }, [ctx, world]);

  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
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
      {paused ? (
        <div
          data-testid="ride-paused"
          style={{
            position: 'absolute',
            top: '40%',
            left: 0,
            right: 0,
            zIndex: Z_CONTROLS,
            textAlign: 'center',
            fontSize: 48,
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          Paused
        </div>
      ) : null}
      <style>{CONTROLS_CSS}</style>
      {/*
        Direct children like the HUD: one stacking context; Pause (or Resume) and Finish ride side
        by side at the bottom centre. They come first in reading order: the first arrow of a ride
        focuses Pause, not a HUD control that changes the ride.
      */}
      {paused ? (
        <Control
          label="Resume"
          icon={RESUME}
          side="left"
          testId="resume-ride"
          onPress={() => ctx.events.publish(activityResumeRequestedEvent, {})}
        />
      ) : (
        <Control
          label="Pause"
          icon={PAUSE}
          side="left"
          testId="pause-ride"
          onPress={() => ctx.events.publish(activityPauseRequestedEvent, {})}
        />
      )}
      <Control
        buttonRef={finish}
        label="Finish ride"
        icon={FINISH}
        side="right"
        testId="finish-ride"
        onPress={() => ctx.events.publish(activityFinishRequestedEvent, {})}
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
  );
}

export const ActivityScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ActivityScreenView ctx={ctx} />);
  return () => root.unmount();
};
