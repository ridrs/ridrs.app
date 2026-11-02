// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  measurementCadenceEvent,
  metricCadenceCapability,
  metricCadenceEvent,
} from '@ridrs/contracts';
import { defineMetricPlugin } from '@ridrs/metric-source';

// Pedalling stops abruptly: cadence is held, never extrapolated.
export default defineMetricPlugin({
  unit: 'rpm',
  name: 'cadence',
  measurementEvent: measurementCadenceEvent,
  metricEvent: metricCadenceEvent,
  capability: metricCadenceCapability,
  strategy: 'hold',
});
