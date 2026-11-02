// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BLE_BRIDGE_HEARTBEAT_INTERVAL_MS,
  BLE_BRIDGE_LINK_TIMEOUT_MS,
  type BridgeMessage,
  type BridgeSocket,
  bridgeMessageSchema,
  type Clock,
} from '@ridrs/contracts';

export function sendMessage(socket: BridgeSocket, message: BridgeMessage): void {
  socket.send(JSON.stringify(message));
}

/** `undefined` for text that is not a valid bridge message. */
export function parseMessage(text: string): BridgeMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = bridgeMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Liveness of one socket: any inbound message counts as a sign of life. Checked every heartbeat
 * interval; after `BLE_BRIDGE_LINK_TIMEOUT_MS` of silence the link is declared dead. Wi-Fi power
 * save on phones produces gaps of several hundred ms, so the timeout is deliberately generous.
 */
export class Liveness {
  private lastSeen: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly clock: Clock,
    onTick: () => void,
    onDead: () => void,
  ) {
    this.lastSeen = clock.now();
    this.timer = setInterval(() => {
      if (this.clock.now() - this.lastSeen >= BLE_BRIDGE_LINK_TIMEOUT_MS) {
        this.stop();
        onDead();
        return;
      }
      onTick();
    }, BLE_BRIDGE_HEARTBEAT_INTERVAL_MS);
  }

  seen(): void {
    this.lastSeen = this.clock.now();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
