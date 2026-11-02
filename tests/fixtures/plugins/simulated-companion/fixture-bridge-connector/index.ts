// SPDX-License-Identifier: AGPL-3.0-or-later

import { bleBridgeConnectorCapability, definePlugin } from '@ridrs/contracts';
import {
  BleSimulator,
  SimulatedBridgeConnector,
  SimulatedCompanion,
  SimulatedNetwork,
} from '@ridrs/testing';

const PACKET_INTERVAL_MS = 250;
const PACKET = '45 00 B8 00 DC 00'; // 220 W, 92 rpm

/** A companion "Pixel 8" (code 482913) in the network, forwarding a trainer that pedals steadily. */
export default definePlugin({
  initialize(ctx) {
    const simulator = new BleSimulator({ clock: ctx.clock });
    const trainer = simulator.addFtmsTrainer('SIM KICKR');
    let timer: ReturnType<typeof setInterval> | undefined;
    trainer.onCentralConnected(() => {
      clearInterval(timer);
      timer = setInterval(() => trainer.notifyIndoorBikeData(PACKET), PACKET_INTERVAL_MS);
    });

    const network = new SimulatedNetwork();
    const companion = new SimulatedCompanion({
      network,
      name: 'Pixel 8',
      address: '192.168.178.110:42229',
      central: simulator,
      clock: ctx.clock,
      code: '482913',
    });

    ctx.signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer);
        companion.server.close();
      },
      { once: true },
    );
    ctx.capabilities.provide(bleBridgeConnectorCapability, new SimulatedBridgeConnector(network));
  },
});
