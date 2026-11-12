// SPDX-License-Identifier: AGPL-3.0-or-later

import { definePlugin, deviceStatusState } from '@ridrs/contracts';

/** A trainer and a heart rate band, both connected: the ride is ready on that side. */
export default definePlugin({
  start(ctx) {
    ctx.state.set(deviceStatusState, 'fixture-briefing-devices/trainer/1', {
      kind: 'trainer',
      deviceId: 'trainer-1',
      deviceName: 'Fixture trainer',
      state: 'connected',
    });
    ctx.state.set(deviceStatusState, 'fixture-briefing-devices/heart-rate/1', {
      kind: 'heart-rate',
      deviceId: 'band-1',
      deviceName: 'Fixture band',
      state: 'connected',
    });
  },
});
