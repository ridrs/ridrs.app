// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EventEnvelope, PhysicsSample, PhysicsStateBatch } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { describe, expect, it } from 'vitest';
import { createPhysicsPresentation, PRESENTATION_DEFAULTS } from './physics-presentation.ts';

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0, 0);
const DELAY = PRESENTATION_DEFAULTS.renderDelayMs;

function sample(step: number, speed = step / 10, distance = step): PhysicsSample {
  return { step, at: T0 + 10 * step, speed, distance, acceleration: 0.1 * step, gradient: 0 };
}

/** A presentation fed by hand, as the shell's `ctx.events` would feed it. */
function presentation() {
  let deliver: ((envelope: EventEnvelope<PhysicsStateBatch>) => void) | undefined;
  let subscriptions = 0;
  const events = {
    subscribe: (_def: unknown, handler: (envelope: EventEnvelope<PhysicsStateBatch>) => void) => {
      deliver = handler;
      subscriptions += 1;
      return () => {
        subscriptions -= 1;
      };
    },
    publish: () => {
      throw new Error('the presentation never publishes');
    },
  } as unknown as UiContext['events'];
  const subject = createPhysicsPresentation(events);
  const receive = (sessionId: string, samples: PhysicsSample[]) =>
    deliver?.({
      id: 'e',
      type: 'physics.state-batch',
      source: 'physics-engine',
      timestamp: 0,
      payload: { sessionId, samples },
    });
  return { subject, receive, subscriptions: () => subscriptions };
}

/** The frame time whose render time is `step`'s time plus `extra` ms. */
const frameAt = (step: number, extra = 0) => T0 + 10 * step + extra + DELAY;

describe('createPhysicsPresentation', () => {
  it('presents nothing before the first batch', () => {
    const { subject } = presentation();
    expect(subject.at(T0)).toEqual({ status: 'none', renderTime: T0 - DELAY });
  });

  it('interpolates linearly between neighbouring steps; discrete values come from the older', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(0, 0, 0), { ...sample(1, 1, 0.5), gradient: 0.05, acceleration: 2 }]);
    const shown = subject.at(frameAt(0, 2.5));
    expect(shown).toMatchObject({ status: 'available', basis: 'interpolated', step: 0 });
    expect(shown.status === 'available' && shown.speed).toBeCloseTo(0.25, 12);
    expect(shown.status === 'available' && shown.distance).toBeCloseTo(0.125, 12);
    expect(shown.status === 'available' && shown.acceleration).toBeCloseTo(0.5, 12);
    expect(shown.status === 'available' && shown.gradient).toBe(0);
  });

  it('shows a sample exactly at its time, and holds the newest after it', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(0), sample(1), sample(2)]);
    expect(subject.at(frameAt(1))).toMatchObject({ basis: 'exact', step: 1, speed: 0.1 });
    expect(subject.at(frameAt(2))).toMatchObject({ basis: 'exact', step: 2 });
    expect(subject.at(frameAt(2, 1))).toMatchObject({ basis: 'held', step: 2, speed: 0.2 });
  });

  it('never extrapolates', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(0, 1), sample(1, 2)]);
    expect(subject.at(frameAt(5))).toMatchObject({ basis: 'held', step: 1, speed: 2 });
  });

  it('starts a new history with a new session', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(100), sample(101)]);
    receive('s2', [{ ...sample(0), at: T0 + 5000 }]);
    expect(subject.at(frameAt(100))).toMatchObject({ status: 'none' });
    expect(subject.at(frameAt(500))).toMatchObject({ basis: 'exact', sessionId: 's2', step: 0 });
  });

  it('never interpolates across a gap, also not for a ride that starts mid-way', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(50), sample(51)]);
    receive('s1', [sample(60)]);
    expect(subject.at(frameAt(55))).toMatchObject({ basis: 'held', step: 51 });
    receive('s1', [sample(61)]);
    expect(subject.at(frameAt(60, 5))).toMatchObject({ basis: 'interpolated', step: 60 });
  });

  it('ignores samples it already has', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(0), sample(1)]);
    receive('s1', [sample(1, 99)]);
    expect(subject.at(frameAt(1))).toMatchObject({ step: 1, speed: 0.1 });
  });

  it('keeps samples back to exactly 2000 ms before the newest', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(0), sample(1)]);
    receive('s1', [sample(200)]);
    expect(subject.at(frameAt(0))).toMatchObject({ basis: 'exact', step: 0 });
    receive('s1', [sample(201)]);
    expect(subject.at(frameAt(0))).toMatchObject({ status: 'none' });
    expect(subject.at(frameAt(1))).toMatchObject({ basis: 'exact', step: 1 });
  });

  it('returns frozen results and never changes the history', () => {
    const { subject, receive } = presentation();
    receive('s1', [sample(0), sample(1)]);
    const first = subject.at(frameAt(0, 5));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(subject.at(T0))).toBe(true);
    expect(() => {
      (first as { speed: number }).speed = 42;
    }).toThrow(TypeError);
    expect(subject.at(frameAt(0, 5))).toEqual(first);
  });

  it('counts every call by its basis', () => {
    const { subject, receive } = presentation();
    subject.at(T0);
    receive('s1', [sample(0), sample(1)]);
    subject.at(frameAt(0));
    subject.at(frameAt(0, 5));
    subject.at(frameAt(3));
    subject.at(frameAt(3));
    expect(subject.stats()).toEqual({ frames: 5, exact: 1, interpolated: 1, held: 2, none: 1 });
  });

  it('releases its subscription on dispose', () => {
    const { subject, subscriptions } = presentation();
    expect(subscriptions()).toBe(1);
    subject.dispose();
    expect(subscriptions()).toBe(0);
  });
});
