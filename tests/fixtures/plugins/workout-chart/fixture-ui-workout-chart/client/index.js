// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): stands in for `ui-workout-chart`. It shows what it was
// given as data attributes and offers one focusable step per interval of the workout, which
// reports `step-focused` when it takes the focus, as the `full` chart does. Updates change the
// attributes only, so the focus stays where it is.
const intervals = (steps) =>
  steps.flatMap((step) => (step.kind === 'repeat' ? intervals(step.steps) : [step]));

export function WorkoutChart(container, _ctx, input, emit) {
  const chart = document.createElement('div');
  chart.dataset.testid = 'fixture-workout-chart';
  const draw = (current) => {
    chart.dataset.workout = current.workout.name;
    chart.dataset.variant = current.variant;
    chart.dataset.ftp = String(current.athlete?.ftp ?? '');
    chart.dataset.selected = current.selectedStep ?? '';
  };
  const steps = intervals(input.workout.steps).map((step) => {
    const element = document.createElement('button');
    element.textContent = `Chart step ${step.id}`;
    element.addEventListener('focus', () => emit('step-focused', { stepId: step.id }));
    return element;
  });
  chart.append(...steps);
  draw(input);
  container.append(chart);
  return {
    update: draw,
    release() {},
  };
}
