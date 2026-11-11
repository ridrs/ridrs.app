// SPDX-License-Identifier: AGPL-3.0-or-later

import { type WorkoutEditorSubject, workoutEditorCapability } from '@ridrs/contracts';
import type { UiContext } from '@ridrs/ui-sdk';
import { useEffect, useRef } from 'react';

/**
 * The workout editor (`ui.workout-editor`, ADR 0083) in place of the area's content, like the
 * details. Without a provider nothing is shown and the area closes it at once. `saved` hands the
 * id of the saved workout on, `closed` closes it.
 */
export function WorkoutEditorView({
  ctx,
  subject,
  onClose,
  onSaved,
}: {
  readonly ctx: UiContext;
  readonly subject: WorkoutEditorSubject;
  readonly onClose: () => void;
  readonly onSaved: (workoutId: string) => void;
}) {
  const place = useRef<HTMLDivElement>(null);
  const handle = useRef<ReturnType<typeof ctx.render<typeof workoutEditorCapability>>>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const drawn = useRef(subject);
  drawn.current = subject;

  useEffect(() => {
    const container = place.current;
    if (!container) return undefined;
    try {
      const details = ctx.render(workoutEditorCapability, container, drawn.current);
      handle.current = details;
      const stops = [
        details.onAvailability((available) => {
          if (!available) close.current();
        }),
        details.on('closed', () => close.current()),
        details.on('saved', ({ workoutId }) => saved.current(workoutId)),
      ];
      return () => {
        for (const stop of stops) stop();
        handle.current = undefined;
        // After this commit: the provider's React root cannot be unmounted while this one commits.
        queueMicrotask(() => details.release());
      };
    } catch (error) {
      ctx.logger.warn(`The workout editor could not be shown: ${String(error)}`);
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
      ctx.logger.warn(`The workout editor refused its subject: ${String(error)}`);
    }
  }, [ctx, subject]);

  return <div ref={place} data-testid="training-workout-editor" />;
}
