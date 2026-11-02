// SPDX-License-Identifier: AGPL-3.0-or-later

import { measurementPowerEvent, metricPowerCapability, metricPowerEvent } from '@ridrs/contracts';
import { defineMetricPlugin } from '@ridrs/metric-source';

// Power follows the rider's effort smoothly enough for a damped trend between packets.
export default defineMetricPlugin({
  unit: 'W',
  name: 'power',
  measurementEvent: measurementPowerEvent,
  metricEvent: metricPowerEvent,
  capability: metricPowerCapability,
  strategy: 'damped-trend',
});
