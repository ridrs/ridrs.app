// SPDX-License-Identifier: AGPL-3.0-or-later

import { trainerTargetPowerEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * One place in the HUD for what the rider steers with: the contributions of `hud/erg-off` while
 * ERG is off (the gear), those of `hud/erg-on` while it is on (the target power). Knows neither
 * widget; it follows `trainer.target-power` only.
 */
function ErgDispatchView({ ctx }: { readonly ctx: UiContext }) {
  const [erg, setErg] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) => setErg(payload.watts !== null)),
    [ctx],
  );
  useEffect(() => {
    if (!container.current) {
      return undefined;
    }
    const release = ctx.slot(erg ? 'hud/erg-on' : 'hud/erg-off', container.current);
    // The widget is a React root of its own: unmounting it while this root commits races, so it
    // is released right after.
    return () => queueMicrotask(release);
  }, [ctx, erg]);
  return <div ref={container} data-testid="erg-dispatch" data-erg={erg} style={{ display: 'contents' }} />;
}

export const ErgDispatchWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ErgDispatchView ctx={ctx} />);
  return () => root.unmount();
};
