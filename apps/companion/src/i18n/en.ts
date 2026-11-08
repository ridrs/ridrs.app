// SPDX-License-Identifier: AGPL-3.0-or-later

/** The companion app's texts in English (ADR 0072): the shape of every language. */
export const en = {
  title: 'ridrs companion',
  developerBuild: 'developer build',
  companionName: 'Companion name',
  rename: 'Rename',
  notAPairingCode: 'That is not a ridrs pairing code. Scan the QR code ridrs shows.',
  scanFailed: (error: string) => `Scanning failed: ${error}`,
  scanned: (ridrs: string) => `Scanned. Waiting for “${ridrs}” to connect…`,
  connected: 'connected',
  disconnectedHere: 'disconnected here',
  disconnectedInRidrs: 'disconnected in ridrs',
  waiting: 'not connected, waiting for it',
  disconnect: 'Disconnect',
  connect: 'Connect',
  forget: 'Forget',
  pairedAndConnected: 'Paired and connected',
  scan: 'Scan ridrs QR code',
  orEnter: 'Or enter this code in ridrs:',
  findsIn: (name: string, addresses: string) =>
    `ridrs finds “${name}” in the same Wi-Fi (${addresses}).`,
  noWifi: 'No Wi-Fi address: connect the phone to Wi-Fi.',
  forwardingTo: (ridrs: string) => `Forwarding to ${ridrs}`,
  notForwarding: 'Not forwarding',
  counts: (devices: number, subscriptions: number, rate: number) =>
    `${devices} device(s) connected · ${subscriptions} subscription(s) · ${rate} notifications/s`,
  keepOpen: 'Keep this app open: the phone forwards Bluetooth only while its screen is on.',
  couldNotStart: (error: string) => `The companion could not start: ${error}`,
};

export type Messages = typeof en;
