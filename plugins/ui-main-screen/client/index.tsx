// SPDX-License-Identifier: AGPL-3.0-or-later

import { activityStartRequestedEvent, activityStateChangedEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function MainScreenView({ ctx }: { readonly ctx: UiContext }) {
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
      <button
        type="button"
        data-testid="start-ride"
        style={{ fontSize: 24, padding: '16px 40px', borderRadius: 12 }}
        onClick={() => ctx.events.publish(activityStartRequestedEvent, {})}
      >
        Start ride
      </button>
    </main>
  );
}

export const MainScreen: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<MainScreenView ctx={ctx} />);
  return () => root.unmount();
};
