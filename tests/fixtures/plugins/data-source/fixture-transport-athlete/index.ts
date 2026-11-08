// SPDX-License-Identifier: AGPL-3.0-or-later

import { athleteProfileState, athleteProfileUpdateService, definePlugin } from '@ridrs/contracts';

/** What a scenario made of this provider before the host started (the World's `dataSourceFixture`). */
interface FixtureConfig {
  readonly status?: 'ready' | 'offline' | 'unavailable';
  readonly weight?: number;
}

const CONFIG = Symbol.for('ridrs.fixture.data-source');

/**
 * A second provider of the athlete profile (ADR 0075), so scenarios can show two choices. It owns
 * the key `fixture-cloud`, cannot be written, and is ready with an athlete of 250 W and 90 kg
 * unless a scenario made it offline or unavailable (nothing to read) or changed its weight.
 */
export default definePlugin({
  start(ctx) {
    const config = ((globalThis as Record<symbol, unknown>)[CONFIG] ?? {}) as FixtureConfig;
    const status = config.status ?? 'ready';
    ctx.state.set(athleteProfileState, 'fixture-cloud', {
      provider: 'fixture-cloud',
      label: 'Fixture cloud',
      status,
      writable: false,
      ...(status === 'unavailable'
        ? {}
        : {
            fetchedAt: ctx.clock.now(),
            data: { name: 'Alex Rider', ftp: 250, weight: config.weight ?? 90 },
          }),
    });
    ctx.services.provide(athleteProfileUpdateService, () => ({
      ok: false as const,
      reason: 'read-only' as const,
    }));
  },
});
