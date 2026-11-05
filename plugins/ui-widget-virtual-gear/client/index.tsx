// SPDX-License-Identifier: AGPL-3.0-or-later

import { type DrivetrainGearChangedPayload, drivetrainGearChangedEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const EN_DASH = '–';

/** The virtual gear: "12" of 24; an en dash until a gear source names one. */
function VirtualGearWidgetView({ ctx }: { readonly ctx: UiContext }) {
  const [gear, setGear] = useState<DrivetrainGearChangedPayload>();
  useEffect(
    () => ctx.events.subscribe(drivetrainGearChangedEvent, ({ payload }) => setGear(payload)),
    [ctx],
  );

  return (
    <section
      data-testid="widget-virtual-gear"
      data-status={gear ? 'available' : 'unavailable'}
      style={{
        pointerEvents: 'auto',
        minWidth: 110,
        padding: '12px 18px',
        borderRadius: 14,
        background: 'rgba(16, 20, 24, 0.72)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.8 }}>Gear</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-testid="value" style={{ fontSize: 44, fontWeight: 700 }}>
          {gear ? String(gear.index) : EN_DASH}
        </span>
        <span data-testid="unit" style={{ fontSize: 18 }}>
          {gear ? `/ ${gear.count}` : ''}
        </span>
      </div>
    </section>
  );
}

export const VirtualGearWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<VirtualGearWidgetView ctx={ctx} />);
  return () => root.unmount();
};
