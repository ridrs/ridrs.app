// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, hostStartedEvent } from '@ridrs/contracts';
import { pingEvent, pongEvent } from '../../../contracts/index.ts';

export default definePlugin({
  start(ctx) {
    ctx.events.subscribe(pongEvent, (envelope) => {
      ctx.logger.info({ sequence: envelope.payload.sequence }, 'example-ping received pong');
    });

    ctx.events.subscribe(hostStartedEvent, () => {
      ctx.events.publish(pingEvent, { sequence: 1 });
    });
  },
});
