// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PresentedPhysics } from '@ridrs/presentation';
import { describe, expect, it } from 'vitest';
import { DEMO_LANDSCAPE, type TerrainWindow } from './landscape-model.ts';
import { TerrainPublisher } from './terrain-publisher.ts';

type Published = TerrainWindow & { readonly revision: number };

function publisher() {
  const published: Published[] = [];
  const subject = new TerrainPublisher(DEMO_LANDSCAPE, (window) => published.push(window));
  return { subject, published };
}

const shown = (distance: number, sessionId = 's-1'): PresentedPhysics => ({
  status: 'available',
  renderTime: 0,
  basis: 'interpolated',
  sessionId,
  step: 1,
  speed: 5,
  distance,
  acceleration: 0,
  gradient: 0,
});

const origins = (published: readonly Published[]) => published.map((w) => w.originDistance);

describe('TerrainPublisher', () => {
  it('publishes the window from 0 m on mount, before any physics state', () => {
    const { subject, published } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-1', startedAt: 0 });
    subject.mount();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ revision: 1, originDistance: 0, spacing: 1 });
    expect(published[0]?.samples).toHaveLength(21);
  });

  it('keeps the first window while more than 10 m of it are ahead', () => {
    const { subject, published } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-1', startedAt: 0 });
    subject.mount();
    subject.frame(shown(0));
    subject.frame(shown(10));
    expect(origins(published)).toEqual([0]);
  });

  it('publishes a new window once less than 10 m are left ahead of the presented position', () => {
    const { subject, published } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-1', startedAt: 0 });
    subject.mount();
    subject.frame(shown(10.2));
    expect(origins(published)).toEqual([0, 10]);
    expect(published.map((w) => w.revision)).toEqual([1, 2]);
    subject.frame(shown(20));
    subject.frame(shown(20.01));
    expect(origins(published)).toEqual([0, 10, 20]);
  });

  it('publishes nothing at standstill', () => {
    const { subject, published } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-1', startedAt: 0 });
    subject.mount();
    for (let frame = 0; frame < 100; frame += 1) {
      subject.frame(shown(3));
    }
    expect(published).toHaveLength(1);
  });

  it('ignores frames of another ride, frames without a state and frames outside a ride', () => {
    const { subject, published } = publisher();
    subject.rideState({ state: 'running', sessionId: 's-2', startedAt: 0 });
    subject.mount();
    // The bridge replays the previous ride's last batch to a new subscriber.
    subject.frame(shown(500, 's-1'));
    subject.frame({ status: 'none', renderTime: 0 });
    subject.rideState({ state: 'finished', sessionId: 's-2', startedAt: 0, endedAt: 1 });
    subject.frame(shown(500, 's-2'));
    expect(origins(published)).toEqual([0]);
  });
});
