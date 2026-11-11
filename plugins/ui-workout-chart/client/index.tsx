// SPDX-License-Identifier: AGPL-3.0-or-later

import type { workoutChartCapability } from '@ridrs/contracts';
import type { UiCapabilityComponent, UiContext } from '@ridrs/ui-sdk';
import { useMessages } from '@ridrs/ui-sdk/react';
import { createRoot } from 'react-dom/client';
import { CHART_CSS, Chart, type ChartInput } from './chart.tsx';
import { messages } from './i18n/index.ts';

function ChartView({
  ctx,
  input,
  onStepFocused,
}: {
  readonly ctx: UiContext;
  readonly input: ChartInput;
  readonly onStepFocused: (stepId: string) => void;
}) {
  const text = useMessages(ctx, messages);
  return (
    <>
      <style>{CHART_CSS}</style>
      <Chart input={input} text={text} onStepFocused={onStepFocused} />
    </>
  );
}

/** `ui.workout-chart` (ADR 0083): draws the workout; an update with the same content draws nothing. */
export const WorkoutChart: UiCapabilityComponent<typeof workoutChartCapability> = (
  container,
  ctx,
  input,
  emit,
) => {
  // React's own element inside the container: the shell empties the container when the drawing is
  // released, and React must not find its children gone from under it.
  const host = document.createElement('div');
  host.style.display = 'contents';
  container.append(host);
  const root = createRoot(host);
  let shown = JSON.stringify(input);
  const draw = (next: ChartInput) =>
    root.render(<ChartView ctx={ctx} input={next} onStepFocused={(stepId) => emit('step-focused', { stepId })} />);
  draw(input);
  return {
    update(next) {
      const key = JSON.stringify(next);
      if (key === shown) return;
      shown = key;
      draw(next);
    },
    release() {
      // Released from inside a render of the consumer: unmount once that is done.
      queueMicrotask(() => root.unmount());
    },
  };
};
