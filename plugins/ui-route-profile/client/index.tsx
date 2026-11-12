// SPDX-License-Identifier: AGPL-3.0-or-later

import { type RouteOffer, routeOfferState, type routeProfileCapability } from '@ridrs/contracts';
import type { UiCapabilityComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CardProfile } from './card.tsx';
import { FullProfile } from './full.tsx';
import { messages } from './i18n/index.ts';

/**
 * The offer of the route from the app state `route.offer` (ADR 0068), as it is now and when it
 * changes: the provider reads the elevations itself, the host only names the route.
 */
function useOffer(ctx: UiContext, route: string): RouteOffer | undefined {
  const [offer, setOffer] = useState<RouteOffer>();
  useEffect(() => ctx.state.watch(routeOfferState, ({ entries }) => setOffer(entries.get(route))), [ctx, route]);
  return offer;
}

function RouteProfileView({
  ctx,
  route,
  variant,
}: {
  readonly ctx: UiContext;
  readonly route: string;
  readonly variant: 'card' | 'full';
}) {
  const text = useMessages(ctx, messages);
  const offer = useOffer(ctx, route);
  if (!offer?.sparkline) return null;
  return variant === 'card' ? <CardProfile offer={offer} text={text} /> : <FullProfile offer={offer} text={text} />;
}

/** Provides `ui.route-profile` (ADR 0083): one React root per drawing, new input without a new mount. */
export const RouteProfile: UiCapabilityComponent<typeof routeProfileCapability> = (container, ctx, input) => {
  const root = createRoot(container);
  const draw = ({ route, variant }: { readonly route: string; readonly variant: 'card' | 'full' }) =>
    root.render(<RouteProfileView ctx={ctx} route={route} variant={variant} />);
  draw(input);
  return { update: draw, release: () => root.unmount() };
};
