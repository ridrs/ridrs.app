// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BleIpc } from './ble/ipc.ts';

export function toHex(data: Uint8Array): string {
  return [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Packet log in the line format of `experiments/hr-monitor-osx/zwift-packet-capture.log`,
 * buffered and appended to `<app data dir>/packet-capture.log` by Rust.
 */
export class PacketLog {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ipc: BleIpc) {}

  start(): void {
    this.buffer.push(`# RIDRS Tauri BLE spike session started at ${new Date().toISOString()}`);
    this.timer = setInterval(() => void this.flush(), 1000);
  }

  line(label: string, kind: string, text: string, wallMs = Date.now()): void {
    this.buffer.push(`[${new Date(wallMs).toISOString()}] [${label}:${kind}] ${text}`);
  }

  packet(label: string, data: Uint8Array, wallMs: number, decoded = ''): void {
    this.line(label, 'NOTIFY', `(${data.byteLength}B) | hex=[${toHex(data)}]${decoded ? ` | ${decoded}` : ''}`, wallMs);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const text = `${this.buffer.join('\n')}\n`;
    this.buffer = [];
    await this.ipc.invoke('log_append', { text });
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
