// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  measurementHeartRateEvent,
  metricHeartRateCapability,
  metricHeartRateEvent,
} from '@ridrs/contracts';
import { defineMetricPlugin } from '@ridrs/metric-source';

// Heart rate reacts slowly and has no useful trend between packets: it is held.
export default defineMetricPlugin({
  unit: 'bpm',
  name: 'heart rate',
  measurementEvent: measurementHeartRateEvent,
  metricEvent: metricHeartRateEvent,
  capability: metricHeartRateCapability,
  strategy: 'hold',
});
