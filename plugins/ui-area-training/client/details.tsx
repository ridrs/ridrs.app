// SPDX-License-Identifier: AGPL-3.0-or-later

import { type WorkoutDetailsSubject, workoutDetailsCapability } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { createContext, useEffect, useRef } from 'react';

/** A workout to show in full, and which control of the area opened it (the focus goes back there). */
export interface DetailsRequest {
  readonly subject: WorkoutDetailsSubject;
  readonly focusKey: string;
}

/** How a card or an entry asks the area to show a workout's details. */
export const OpenDetails = createContext<(request: DetailsRequest) => void>(() => undefined);

/** The control that opened the details: marked so the area finds it again once they close. */
export const focusKeyProps = (focusKey: string) => ({ 'data-focus-key': focusKey });

/** Puts the focus back on the control a request came from, when it is in the page. */
export function focusBack(focusKey: string): void {
  document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

/**
 * The details of one workout (`ui.workout-details`, ADR 0083) in place of the area's content,
 * the way route details are an inner view of the Ride area. Without a provider nothing is shown
 * and the area is asked to close them at once: the card stays.
 */
export function WorkoutDetailsView({
  ctx,
  subject,
  onClose,
}: {
  readonly ctx: UiContext;
  readonly subject: WorkoutDetailsSubject;
  readonly onClose: () => void;
}) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<ReturnType<typeof ctx.render<typeof workoutDetailsCapability>>>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  const drawn = useRef(subject);
  drawn.current = subject;

  useEffect(() => {
    const container = place.current;
    if (!container) return undefined;
    try {
      const details = ctx.render(workoutDetailsCapability, container, drawn.current);
      handle.current = details;
      const stops = [
        details.onAvailability((available) => {
          if (!available) close.current();
        }),
        details.on('back', () => close.current()),
      ];
      return () => {
        for (const stop of stops) stop();
        handle.current = undefined;
        // After this commit: the provider's React root cannot be unmounted while this one commits.
        queueMicrotask(() => details.release());
      };
    } catch (error) {
      ctx.logger.warn(`The workout details could not be shown: ${String(error)}`);
      close.current();
      return undefined;
    }
  }, [ctx]);

  // Not on the first render: the drawing was made with this subject.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      handle.current?.update(subject);
    } catch (error) {
      ctx.logger.warn(`The workout details refused their subject: ${String(error)}`);
    }
  }, [ctx, subject]);

  return <div ref={place} data-testid="training-workout-details" />;
}
