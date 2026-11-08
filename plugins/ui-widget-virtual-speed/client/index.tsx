// SPDX-License-Identifier: AGPL-3.0-or-later

import { type PhysicsState, physicsStateEvent } from '@ridrs/contracts';
import { formatDecimal, localizeNumber, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';

const EN_DASH = '–';

/** The virtual speed (m/s) in km/h, one decimal; an en dash until the first physics state. */
function VirtualSpeedWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
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
      <div style={{ fontSize: 14, opacity: 0.8 }}>{text.title}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {state ? localizeNumber(formatDecimal(state.speed * 3.6, 1), language) : EN_DASH}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          {text.unit}
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
