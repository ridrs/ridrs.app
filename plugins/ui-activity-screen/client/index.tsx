// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  activityFinishRequestedEvent,
  activityPauseRequestedEvent,
  activityResumeRequestedEvent,
  activityStateChangedEvent,
} from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** Explicit stacking order of this screen's layers, bottom to top. */
const Z_LANDSCAPE = 0;
const Z_HUD = 1;
const Z_CONTROLS = 2;

/** Another plugin's screen, there or not: the screen only knows its id. */
const DEBRIEFING = 'debriefing';

const BUTTON: CSSProperties = { fontSize: 18, padding: '10px 20px', borderRadius: 10 };

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
      {/*
        Direct children like the HUD: one stacking context; Pause left, Finish ride right. They
        come first in reading order: the first arrow of a ride focuses Pause, not a HUD control
        that changes the ride.
      */}
      {paused ? (
        <button
          type="button"
          data-testid="resume-ride"
          style={{ ...BUTTON, position: 'absolute', top: 16, left: 16, zIndex: Z_CONTROLS }}
          onClick={() => ctx.events.publish(activityResumeRequestedEvent, {})}
        >
          Resume
        </button>
      ) : (
        <button
          type="button"
          data-testid="pause-ride"
          style={{ ...BUTTON, position: 'absolute', top: 16, left: 16, zIndex: Z_CONTROLS }}
          onClick={() => ctx.events.publish(activityPauseRequestedEvent, {})}
        >
          Pause
        </button>
      )}
      <button
        ref={finish}
        type="button"
        data-testid="finish-ride"
        style={{ ...BUTTON, position: 'absolute', top: 16, right: 16, zIndex: Z_CONTROLS }}
        onClick={() => ctx.events.publish(activityFinishRequestedEvent, {})}
      >
        Finish ride
      </button>
      <div
        data-testid="slot-activity-landscape"
        ref={landscape}
        style={{ position: 'absolute', inset: 0, zIndex: Z_LANDSCAPE }}
      />
      <div
        data-testid="slot-activity-hud"
        ref={hud}
        style={{ position: 'absolute', inset: 0, zIndex: Z_HUD, pointerEvents: 'none' }}
      />
    </div>
  );
}

export const ActivityScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ActivityScreenView ctx={ctx} />);
  return () => root.unmount();
};
