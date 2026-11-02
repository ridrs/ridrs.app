// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { describeMetricReading, formatDecimal } from './metric-display.ts';

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

  it('shows two decimals for W/bpm, half up', () => {
    const ratio = (value: number) =>
      describeMetricReading({
        status: 'available',
        value,
        unit: 'W/bpm',
        deviceId: 'metric-power-heart-rate-ratio',
        measuredAt: 0,
        receivedAt: 0,
      }).text;
    expect(ratio(200 / 150)).toBe('1.33');
    expect(ratio(220 / 145)).toBe('1.52');
    expect(ratio(1.005)).toBe('1.01');
    expect(ratio(2)).toBe('2.00');
  });

  it('shows whole beats per minute and labels a warming-up metric', () => {
    expect(
      describeMetricReading({
        status: 'available',
        value: 144.5,
        unit: 'bpm',
        deviceId: 'hrm-1',
        measuredAt: 0,
        receivedAt: 0,
      }).text,
    ).toBe('145');
    expect(
      describeMetricReading({
        status: 'unavailable',
        unit: 'W/bpm',
        reason: 'insufficient-data',
        since: 0,
      }).reason,
    ).toBe('warming up');
  });

  it('shows a dash without a reason before the first reading', () => {
    expect(describeMetricReading(undefined)).toEqual({ status: 'unavailable', text: '–' });
  });
});

describe('formatDecimal', () => {
  it('rounds half up to the given decimals', () => {
    expect(formatDecimal(1.005, 2)).toBe('1.01');
    expect(formatDecimal(34.25, 1)).toBe('34.3');
    expect(formatDecimal(0.004999, 2)).toBe('0.00');
    expect(formatDecimal(12, 1)).toBe('12.0');
  });

  it('shows -0 as 0', () => {
    expect(formatDecimal(-0, 1)).toBe('0.0');
    expect(formatDecimal(-0.01, 1)).toBe('0.0');
  });

  it('handles values JavaScript prints in exponent notation', () => {
    expect(formatDecimal(1.5e-7, 1)).toBe('0.0');
  });
});
