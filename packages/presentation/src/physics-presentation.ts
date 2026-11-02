// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type PhysicsSample,
  type PhysicsStateBatch,
  physicsStateBatchEvent,
} from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';

export const PRESENTATION_DEFAULTS = Object.freeze({
  /** A frame shows the physics this long ago: one batch (50 ms) plus one step (10 ms). */
  renderDelayMs: 60,
  /** Samples are kept back to this long before the newest one. */
  historyMs: 2000,
});

export type PresentationBasis = 'exact' | 'interpolated' | 'held';

export type PresentedPhysics =
  | { readonly status: 'none'; readonly renderTime: number }
  | {
      readonly status: 'available';
      readonly renderTime: number;
      readonly basis: PresentationBasis;
      readonly sessionId: string;
      /** The sample at or before `renderTime`. */
      readonly step: number;
      /** m/s */
      readonly speed: number;
      /** m */
      readonly distance: number;
      /** m/s² */
      readonly acceleration: number;
      /** Rise over run. */
      readonly gradient: number;
    };

export interface PresentationStats {
  readonly frames: number;
  readonly exact: number;
  readonly interpolated: number;
  readonly held: number;
  readonly none: number;
}

export interface PhysicsPresentation {
  /** The state to show for a frame at `frameTime` (host clock): evaluated at frameTime − renderDelay. */
  at(frameTime: number): PresentedPhysics;
  /** How many `at` calls had each basis. */
  stats(): PresentationStats;
  dispose(): void;
}

const lerp = (from: number, to: number, f: number) => from + (to - from) * f;

/**
 * The samples of one session, ascending by step. Consecutive steps are interpolated; anything
 * else is a gap, which is never crossed.
 */
class SampleHistory {
  private sessionId: string | undefined;
  private samples: PhysicsSample[] = [];

  receive({ sessionId, samples }: PhysicsStateBatch): void {
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.samples = [];
    }
    for (const sample of samples) {
      const newest = this.samples.at(-1);
      // A replayed or repeated batch adds nothing.
      if (!newest || sample.step > newest.step) {
        this.samples.push(sample);
      }
    }
    const oldestKept = (this.samples.at(-1)?.at ?? 0) - PRESENTATION_DEFAULTS.historyMs;
    const firstKept = this.samples.findIndex((sample) => sample.at >= oldestKept);
    this.samples.splice(0, firstKept);
  }

  stateAt(renderTime: number): PresentedPhysics {
    const samples = this.samples;
    const sessionId = this.sessionId;
    const oldest = samples[0];
    if (!oldest || sessionId === undefined || renderTime < oldest.at) {
      return Object.freeze({ status: 'none', renderTime });
    }
    // The newest sample at or before the render time; the history is tiny, so a scan is enough.
    let index = samples.length - 1;
    while ((samples[index]?.at ?? renderTime) > renderTime) {
      index -= 1;
    }
    const a = samples[index] ?? oldest;
    const b = samples[index + 1];
    const show = (basis: PresentationBasis, values: PhysicsSample): PresentedPhysics =>
      Object.freeze({
        status: 'available',
        renderTime,
        basis,
        sessionId,
        step: values.step,
        speed: values.speed,
        distance: values.distance,
        acceleration: values.acceleration,
        gradient: values.gradient,
      });
    if (a.at === renderTime) {
      return show('exact', a);
    }
    if (!b || b.step !== a.step + 1) {
      return show('held', a);
    }
    const f = (renderTime - a.at) / (b.at - a.at);
    return show('interpolated', {
      ...a,
      speed: lerp(a.speed, b.speed, f),
      distance: lerp(a.distance, b.distance, f),
      acceleration: lerp(a.acceleration, b.acceleration, f),
    });
  }
}

/**
 * The UI side of the physics: keeps the last two seconds of `physics.state-batch` samples and
 * answers which state a frame shows. Read-only: it never publishes and never reaches the
 * simulation. The consuming plugin declares `physics.state-batch` in `ui.events.subscribe`.
 */
export function createPhysicsPresentation(events: UiContext['events']): PhysicsPresentation {
  const history = new SampleHistory();
  const counts = { frames: 0, exact: 0, interpolated: 0, held: 0, none: 0 };
  const unsubscribe = events.subscribe(physicsStateBatchEvent, ({ payload }) =>
    history.receive(payload),
  );
  return {
    at(frameTime) {
      const presented = history.stateAt(frameTime - PRESENTATION_DEFAULTS.renderDelayMs);
      counts.frames += 1;
      counts[presented.status === 'none' ? 'none' : presented.basis] += 1;
      return presented;
    },
    stats: () => Object.freeze({ ...counts }),
    dispose: unsubscribe,
  };
}
