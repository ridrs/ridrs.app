// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MetricReading, metricPowerHeartRateRatioEvent } from '@ridrs/contracts';
import { describeMetricReading, type UiComponent, type UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function PowerHeartRateRatioWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [reading, setReading] = useState<MetricReading>();
  useEffect(() => ctx.events.subscribe(metricPowerHeartRateRatioEvent, ({ payload }) => setReading(payload)), [ctx]);
  const display = describeMetricReading(reading);

  return (
    <section
      data-testid="widget-power-heart-rate-ratio"
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
      <div style={{ fontSize: 14, opacity: 0.8 }}>Power / HR</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {display.text}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          W/bpm
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

export const PowerHeartRateRatioWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<PowerHeartRateRatioWidgetView ctx={ctx} />);
  return () => root.unmount();
};
