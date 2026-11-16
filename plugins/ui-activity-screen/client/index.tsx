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
      <style>{CONTROLS_CSS}</style>
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
