// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { describeMetricReading } from './metric-display.ts';

const available = (value: number) =>
  ({ status: 'available', value, unit: 'W', deviceId: 'd', measuredAt: 0, receivedAt: 0 }) as const;

describe('describeMetricReading', () => {
  it('rounds to whole numbers, half up', () => {
    expect(describeMetricReading(available(90.5)).text).toBe('91');
    expect(describeMetricReading(available(90.49)).text).toBe('90');
    expect(describeMetricReading(available(199.5)).text).toBe('200');
  });

  it('shows zero as a real value', () => {
    expect(describeMetricReading(available(0))).toEqual({ status: 'available', text: '0' });
    expect(describeMetricReading(available(-0.2)).text).toBe('0');
  });

  it('shows a dash and the reason label when unavailable', () => {
    const labels = (['no-source', 'disconnected', 'stale'] as const).map(
      (reason) =>
        describeMetricReading({ status: 'unavailable', unit: 'rpm', reason, since: 0 }).reason,
    );
    expect(labels).toEqual(['no source', 'disconnected', 'no signal']);
    expect(
      describeMetricReading({ status: 'unavailable', unit: 'rpm', reason: 'stale', since: 0 }).text,
    ).toBe('–');
  });

  it('shows a dash without a reason before the first reading', () => {
    expect(describeMetricReading(undefined)).toEqual({ status: 'unavailable', text: '–' });
  });
});
