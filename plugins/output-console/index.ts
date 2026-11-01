// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  definePlugin,
  type MetricReading,
  metricCadenceCapability,
  metricCadenceEvent,
  metricPowerCapability,
  metricPowerEvent,
} from '@ridrs/contracts';
import { distinctUntilChanged, map, Subject } from 'rxjs';

function valueOf(reading: MetricReading): number | null {
  return reading.status === 'available' ? reading.value : null;
}

function statusOf(reading: MetricReading): string {
  return reading.status === 'available' ? 'available' : reading.reason;
}

export default definePlugin({
  start(ctx) {
    const power = ctx.capabilities.get(metricPowerCapability);
    const cadence = ctx.capabilities.get(metricCadenceCapability);

    const changes = new Subject<void>();
    const subscription = changes
      .pipe(
        map(() => {
          const p = power.latest();
          const c = cadence.latest();
          return {
            power: valueOf(p),
            powerStatus: statusOf(p),
            cadence: valueOf(c),
            cadenceStatus: statusOf(c),
          };
        }),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      )
      .subscribe((line) => ctx.logger.info(line, 'live'));

    ctx.events.subscribe(metricPowerEvent, () => changes.next());
    ctx.events.subscribe(metricCadenceEvent, () => changes.next());
    ctx.signal.addEventListener('abort', () => subscription.unsubscribe(), { once: true });

    changes.next();
  },
});
