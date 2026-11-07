// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { mergeDeviceStatuses } from './device-status.ts';
import type { DeviceStatus } from './events.ts';

const status = (
  fields: Partial<DeviceStatus> & Pick<DeviceStatus, 'kind' | 'state'>,
): DeviceStatus => ({
  deviceId: '',
  deviceName: '',
  ...fields,
});

describe('mergeDeviceStatuses', () => {
  it('gives one status per kind, in kind order', () => {
    const merged = mergeDeviceStatuses([
      status({ kind: 'controller', state: 'searching' }),
      status({ kind: 'trainer', state: 'connected', deviceId: 't', deviceName: 'KICKR' }),
    ]);
    expect(merged.map((s) => [s.kind, s.state])).toEqual([
      ['trainer', 'connected'],
      ['controller', 'searching'],
    ]);
  });

  it('lets the most connected link of a kind stand for it, with the devices of all links', () => {
    const [merged] = mergeDeviceStatuses([
      status({
        kind: 'controller',
        state: 'searching',
        candidates: [{ deviceId: 'a', deviceName: 'Zwift Ride', routes: ['local'] }],
        scanning: ['local'],
      }),
      status({
        kind: 'controller',
        state: 'connected',
        deviceId: 'b',
        deviceName: 'Zwift Ride',
        candidates: [
          { deviceId: 'b', deviceName: 'Zwift Ride', routes: ['local'] },
          { deviceId: 'a', deviceName: 'Zwift Ride', routes: ['local'] },
        ],
        scanning: ['local', 'companion'],
      }),
    ]);
    expect(merged?.deviceId).toBe('b');
    expect(merged?.candidates?.map((c) => c.deviceId)).toEqual(['a', 'b']);
    expect(merged?.scanning).toEqual(['local', 'companion']);
  });

  it('keeps candidates and scanning absent when no link names them', () => {
    const [merged] = mergeDeviceStatuses([status({ kind: 'trainer', state: 'searching' })]);
    expect(merged).toEqual({ kind: 'trainer', state: 'searching', deviceId: '', deviceName: '' });
  });
});
