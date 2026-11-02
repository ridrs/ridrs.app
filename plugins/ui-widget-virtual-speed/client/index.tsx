// SPDX-License-Identifier: AGPL-3.0-or-later

import { type PhysicsState, physicsStateEvent } from '@ridrs/contracts';
import { formatDecimal, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const EN_DASH = '–';

/** The virtual speed (m/s) in km/h, one decimal; an en dash until the first physics state. */
function VirtualSpeedWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [state, setState] = useState<PhysicsState>();
  useEffect(() => ctx.events.subscribe(physicsStateEvent, ({ payload }) => setState(payload)), [ctx]);

  return (
    <section
      data-testid="widget-virtual-speed"
      data-status={state ? 'available' : 'unavailable'}
      style={{
        pointerEvents: 'auto',
        minWidth: 140,
        padding: '12px 18px',
        borderRadius: 14,
        background: 'rgba(16, 20, 24, 0.72)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.8 }}>Speed</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {state ? formatDecimal(state.speed * 3.6, 1) : EN_DASH}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          km/h
        </span>
      </div>
    </section>
  );
}

export const VirtualSpeedWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<VirtualSpeedWidgetView ctx={ctx} />);
  return () => root.unmount();
};
