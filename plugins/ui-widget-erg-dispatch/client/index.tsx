// SPDX-License-Identifier: AGPL-3.0-or-later

import { trainerTargetPowerEvent, workoutHaltChangedEvent } from '@ridrs/contracts';
import type { UiComponent, UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * One place in the HUD for what the rider steers with: the contributions of `hud/erg-off` while
 * ERG is off (the gear), those of `hud/erg-on` while it is on (the target power). Knows neither
 * widget; it follows `trainer.target-power`, and keeps ERG's place while the workout halts itself
 * (ADR 0113): then the trainer rides the route, but the target is what the rider goes back to.
 */
function ErgDispatchView({ ctx }: { readonly ctx: UiContext }) {
  const [target, setTarget] = useState(false);
  const [halted, setHalted] = useState(false);
  const erg = target || halted;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stopTarget = ctx.events.subscribe(trainerTargetPowerEvent, ({ payload }) =>
      setTarget(payload.watts !== null),
    );
    const stopHalt = ctx.events.subscribe(workoutHaltChangedEvent, ({ payload }) =>
      setHalted(payload.state !== 'running'),
    );
    return () => {
      stopTarget();
      stopHalt();
    };
  }, [ctx]);
  useEffect(() => {
    if (!container.current) {
      return undefined;
    }
    return ctx.slot(erg ? 'hud/erg-on' : 'hud/erg-off', container.current);
  }, [ctx, erg]);
  return <div ref={container} data-testid="erg-dispatch" data-erg={erg} style={{ display: 'contents' }} />;
}

export const ErgDispatchWidget: UiComponent = (container, ctx) => {
  const root = createRoot(container);
  root.render(<ErgDispatchView ctx={ctx} />);
  return () => root.unmount();
};
