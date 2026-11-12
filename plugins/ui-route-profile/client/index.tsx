// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type RouteOffer,
  routeOfferState,
  type routeProfileCapability,
  type UiCapabilityInput,
} from '@ridrs/contracts';
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

type Input = UiCapabilityInput<typeof routeProfileCapability>;

function RouteProfileView({ ctx, input: { route, variant, preview } }: { readonly ctx: UiContext; readonly input: Input }) {
  const text = useMessages(ctx, messages);
  const offer = useOffer(ctx, route);
  // A route that is no offer yet brings its title and elevations; its card needs no more.
  if (preview && variant === 'card') return <CardProfile offer={{ id: route, ...preview }} text={text} />;
  if (!offer?.sparkline) return null;
  return variant === 'card' ? <CardProfile offer={offer} text={text} /> : <FullProfile offer={offer} text={text} />;
}

/** Provides `ui.route-profile` (ADR 0083): one React root per drawing, new input without a new mount. */
export const RouteProfile: UiCapabilityComponent<typeof routeProfileCapability> = (container, ctx, input) => {
  const root = createRoot(container);
  const draw = (next: Input) => root.render(<RouteProfileView ctx={ctx} input={next} />);
  draw(input);
  return { update: draw, release: () => root.unmount() };
};
