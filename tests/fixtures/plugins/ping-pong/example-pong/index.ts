// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin } from '@ridrs/contracts';
import { pingEvent, pongEvent } from '../../../contracts/index.ts';

export default definePlugin({
  start(ctx) {
    ctx.events.subscribe(pingEvent, (envelope) => {
      ctx.logger.info({ sequence: envelope.payload.sequence }, 'example-pong received ping');
      ctx.events.publish(pongEvent, { sequence: envelope.payload.sequence });
    });
  },
});
