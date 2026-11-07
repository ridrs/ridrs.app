// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, routeOfferState } from '@ridrs/contracts';
import { demoCourseOffer } from './offer.ts';

// The landscape lives in the client module (see `ui` in the manifest): the model, the drawing and
// the terrain it publishes. The host side offers the demo course to the ride page as its key of
// the app state `route.offer` (ADR 0068); stopping the plugin removes the offer and its UI.
export default definePlugin({
  start(ctx) {
    const offer = demoCourseOffer();
    ctx.state.set(routeOfferState, offer.id, offer);
  },
});
