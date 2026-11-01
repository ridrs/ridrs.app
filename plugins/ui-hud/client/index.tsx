// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Lays the widgets out in the lower corners, over whatever lies below. The HUD itself lets pointer
 * events through so controls of the screen stay reachable; only the widgets take them.
 */
function HudView({ ctx }: { readonly ctx: UiContext }) {
  const widgets = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!widgets.current) {
      return undefined;
    }
    return ctx.slot('hud/widget', widgets.current);
  }, [ctx]);

  return (
    <div data-testid="hud" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div
        data-testid="slot-hud-widget"
        ref={widgets}
        style={{
          position: 'absolute',
          left: 16,
          right: 16,
          bottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

export const Hud: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<HudView ctx={ctx} />);
  return () => root.unmount();
};
