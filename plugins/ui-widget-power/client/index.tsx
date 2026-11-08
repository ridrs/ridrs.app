// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MetricReading, metricPowerEvent } from '@ridrs/contracts';
import { describeMetricReading, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useLanguage, useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { messages } from './i18n/index.ts';

function PowerWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const text = useMessages(ctx, messages);
  const language = useLanguage(ctx);
  const [reading, setReading] = useState<MetricReading>();
  useEffect(() => ctx.events.subscribe(metricPowerEvent, ({ payload }) => setReading(payload)), [ctx]);
  const display = describeMetricReading(reading, language);

  return (
    <section
      data-testid="widget-power"
      data-status={display.status}
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
          {display.text}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          {text.unit}
        </span>
      </div>
      {display.reason !== undefined && (
        <div data-testid="reason" style={{ fontSize: 13, opacity: 0.8 }}>
          {display.reason}
        </div>
      )}
    </section>
  );
}

export const PowerWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<PowerWidgetView ctx={ctx} />);
  return () => root.unmount();
};
