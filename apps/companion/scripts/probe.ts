// SPDX-License-Identifier: AGPL-3.0-or-later

// Developer tool: pairs with a companion like ridrs does and prints what its trainer sends.
//   pnpm --filter @ridrs/companion probe <host:port> <pairing code>
// Uses the real bridge protocol (packages/ble-bridge) over Node's WebSocket client.

import { BridgeSession } from '@ridrs/ble-bridge';
import {
  type BridgeSocket,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
} from '@ridrs/contracts';

function openSocket(address: string): Promise<BridgeSocket> {
  const ws = new WebSocket(`ws://${address}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error(`cannot connect to ${address}`));
    ws.onopen = () =>
      resolve({
        send: (message) => ws.send(typeof message === 'string' ? message : message.slice()),
        onMessage: (listener) => {
          const handler = (e: MessageEvent) =>
            listener(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
          ws.addEventListener('message', handler);
          return () => ws.removeEventListener('message', handler);
        },
        onClose: (listener) => {
          const handler = (e: CloseEvent) => listener(e.reason || `code ${e.code}`);
          ws.addEventListener('close', handler);
          return () => ws.removeEventListener('close', handler);
        },
        close: () => ws.close(),
      });
  });
}

const [address, code, seconds = '10'] = process.argv.slice(2);
if (!address || !code) {
  console.error('usage: probe <host:port> <pairing code> [seconds]');
  process.exit(2);
}

const session = await BridgeSession.open(await openSocket(address), {
  clock: { now: () => Date.now() },
  clientName: 'ridrs probe',
  pairingCode: code,
});
console.log(`paired with "${session.welcome.companionName}" (${session.welcome.companionId})`);

const scan = new AbortController();
setTimeout(() => scan.abort(), 15_000);
let trainer: { peripheralId: string; name: string } | undefined;
for await (const p of session.scan({ serviceUuids: [FTMS_SERVICE_UUID], signal: scan.signal })) {
  trainer = p;
  break;
}
if (!trainer) {
  console.error('no FTMS trainer found within 15 s');
  process.exit(1);
}
console.log(`found ${trainer.name} (${trainer.peripheralId})`);

const connection = await session.connect(trainer.peripheralId);
const started = Date.now();
let count = 0;
await connection.subscribe(
  { serviceUuid: FTMS_SERVICE_UUID, characteristicUuid: INDOOR_BIKE_DATA_CHARACTERISTIC_UUID },
  (data) => {
    count += 1;
    const hex = [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`+${String(Date.now() - started).padStart(5)} ms  ${hex}`);
  },
);
await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000));
console.log(`${count} notifications in ${seconds} s`);
await connection.disconnect();
session.close();
