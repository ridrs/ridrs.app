// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { defineCapability } from './capabilities.ts';
import { defineEvent } from './events.ts';

export const metricUnitSchema = z.enum(['W', 'rpm']);
export type MetricUnit = z.infer<typeof metricUnitSchema>;

export const metricUnavailableReasonSchema = z.enum(['no-source', 'disconnected', 'stale']);
export type MetricUnavailableReason = z.infer<typeof metricUnavailableReasonSchema>;

export type MetricReading<TUnit extends MetricUnit = MetricUnit> =
  | {
      readonly status: 'available';
      readonly value: number;
      readonly unit: TUnit;
      readonly deviceId: string;
      readonly measuredAt: number;
      readonly receivedAt: number;
    }
  | {
      readonly status: 'unavailable';
      readonly unit: TUnit;
      readonly reason: MetricUnavailableReason;
      readonly since: number;
    };

function createMetricReadingSchema<TUnit extends MetricUnit>(
  unitLiteral: TUnit,
): z.ZodType<MetricReading<TUnit>> {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('available'),
      value: z.number(),
      unit: z.literal(unitLiteral),
      deviceId: z.string().min(1),
      measuredAt: z.number(),
      receivedAt: z.number(),
    }),
    z.object({
      status: z.literal('unavailable'),
      unit: z.literal(unitLiteral),
      reason: metricUnavailableReasonSchema,
      since: z.number(),
    }),
  ]);
}

export const powerMetricReadingSchema = createMetricReadingSchema('W');
export const cadenceMetricReadingSchema = createMetricReadingSchema('rpm');

export const metricReadingSchema: z.ZodType<MetricReading> = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    value: z.number(),
    unit: metricUnitSchema,
    deviceId: z.string().min(1),
    measuredAt: z.number(),
    receivedAt: z.number(),
  }),
  z.object({
    status: z.literal('unavailable'),
    unit: metricUnitSchema,
    reason: metricUnavailableReasonSchema,
    since: z.number(),
  }),
]);

export const metricPowerEvent = defineEvent('metric.power', powerMetricReadingSchema);
export const metricCadenceEvent = defineEvent('metric.cadence', cadenceMetricReadingSchema);

export interface MetricCapability<TUnit extends MetricUnit = MetricUnit> {
  latest(): MetricReading<TUnit>;
}

export const metricPowerCapability = defineCapability<
  MetricCapability<'W'>,
  'single',
  'metric.power'
>('metric.power', { cardinality: 'single' });

export const metricCadenceCapability = defineCapability<
  MetricCapability<'rpm'>,
  'single',
  'metric.cadence'
>('metric.cadence', { cardinality: 'single' });
