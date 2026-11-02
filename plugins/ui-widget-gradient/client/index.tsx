// SPDX-License-Identifier: AGPL-3.0-or-later

import { type PhysicsState, physicsStateEvent } from '@ridrs/contracts';
import { formatDecimal, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const EN_DASH = '–';

/**
 * The gradient of the road the forces used, in percent with one decimal; an en dash until the
 * first physics state. Downhill shows an ASCII minus: "-5.0".
 */
function GradientWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [state, setState] = useState<PhysicsState>();
  useEffect(() => ctx.events.subscribe(physicsStateEvent, ({ payload }) => setState(payload)), [ctx]);

  return (
    <section
      data-testid="widget-gradient"
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
      <div style={{ fontSize: 14, opacity: 0.8 }}>Gradient</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {state ? formatDecimal(state.road.gradient * 100, 1) : EN_DASH}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          %
        </span>
      </div>
    </section>
  );
}

export const GradientWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<GradientWidgetView ctx={ctx} />);
  return () => root.unmount();
};
