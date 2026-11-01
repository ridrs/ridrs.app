// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityFinishRequestedEvent, activityStateChangedEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

/** Explicit stacking order of this screen's layers, bottom to top. */
const Z_LANDSCAPE = 0;
const Z_HUD = 1;
const Z_CONTROLS = 2;

function ActivityScreenView({ ctx }: { readonly ctx: UiContext }) {
  const landscape = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLDivElement>(null);

  // The screen only offers extension points; it never knows who contributes to them.
  useEffect(() => {
    if (!landscape.current || !hud.current) {
      return undefined;
    }
    const closeLandscape = ctx.slot('activity/landscape', landscape.current);
    const closeHud = ctx.slot('activity/hud', hud.current);
    return () => {
      closeHud();
      closeLandscape();
    };
  }, [ctx]);

  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state !== 'running') {
          ctx.navigate('main');
        }
      }),
    [ctx],
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
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
      <button
        type="button"
        data-testid="finish-ride"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          zIndex: Z_CONTROLS,
          fontSize: 18,
          padding: '10px 20px',
          borderRadius: 10,
        }}
        onClick={() => ctx.events.publish(activityFinishRequestedEvent, {})}
      >
        Finish ride
      </button>
    </div>
  );
}

export const ActivityScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ActivityScreenView ctx={ctx} />);
  return () => root.unmount();
};
