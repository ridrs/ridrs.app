// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStartRequestedEvent, activityStateChangedEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { RideSaved } from './ride-saved.tsx';

function MainScreenView({ ctx }: { readonly ctx: UiContext }) {
  const status = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // What the rider should know before starting (the devices and the like), above the start button.
  useEffect(() => (status.current ? ctx.slot('main/status', status.current) : undefined), [ctx]);

  // Panels below the start button (device pairing and the like); the screen does not know them.
  useEffect(() => (panel.current ? ctx.slot('main/panel', panel.current) : undefined), [ctx]);

  // Navigation follows the activity state, not the click: a replayed "running" state after a
  // reload leads back into the ride as well.
  useEffect(
    () =>
      ctx.events.subscribe(activityStateChangedEvent, ({ payload }) => {
        if (payload.state === 'running') {
          ctx.navigate('activity');
        }
      }),
    [ctx],
  );

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        height: '100%',
      }}
    >
      <h1 style={{ margin: 0, fontSize: 48 }}>ridrs</h1>
      <div data-testid="slot-main-status" ref={status} />
      <button
        type="button"
        data-testid="start-ride"
        style={{ fontSize: 24, padding: '16px 40px', borderRadius: 12 }}
        onClick={() => ctx.events.publish(activityStartRequestedEvent, {})}
      >
        Start ride
      </button>
      <RideSaved ctx={ctx} />
      <div data-testid="slot-main-panel" ref={panel} />
    </main>
  );
}

export const MainScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<MainScreenView ctx={ctx} />);
  return () => root.unmount();
};
