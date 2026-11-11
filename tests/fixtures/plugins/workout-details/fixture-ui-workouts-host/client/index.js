// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): lists the fixture library and calendar as buttons and
// opens the details of one with Enter, as the Training area and Today do: it draws
// `ui.workout-details` in place of its list, closes them on their `back` and gives the focus back
// to the button that opened them.
import {
  trainingCalendarState,
  trainingLibraryState,
  workoutDetailsCapability,
} from '@ridrs/contracts';

const PROVIDER = 'fixture-library';

export function WorkoutsHost(container, ctx) {
  const list = document.createElement('div');
  list.dataset.testid = 'fixture-workouts';
  const place = document.createElement('div');
  place.dataset.testid = 'fixture-details-place';
  container.append(list);
  let library = [];
  let calendar = [];
  let open;

  const button = (label, subject) => {
    const element = document.createElement('button');
    element.textContent = label;
    element.addEventListener('click', () => show(subject, label));
    return element;
  };
  const draw = () => {
    list.replaceChildren(
      ...library.map((workout) =>
        button(workout.name, { kind: 'library', from: PROVIDER, workoutId: workout.id }),
      ),
      ...calendar.map((entry) =>
        button(`${entry.name} on ${entry.date}`, { kind: 'planned', from: PROVIDER, id: entry.id }),
      ),
    );
  };
  const show = (subject, label) => {
    list.remove();
    container.append(place);
    const handle = ctx.render(workoutDetailsCapability, place, subject);
    handle.onAvailability((available) => {
      if (!available) place.textContent = 'No details here';
    });
    handle.on('back', close);
    open = { handle, label };
  };
  const close = () => {
    if (!open) return;
    const { handle, label } = open;
    open = undefined;
    handle.release();
    place.remove();
    container.append(list);
    [...list.querySelectorAll('button')].find((element) => element.textContent === label)?.focus();
  };

  const stops = [
    ctx.state.watch(trainingLibraryState, ({ entries }) => {
      library = entries.get(PROVIDER)?.data?.workouts ?? [];
      draw();
    }),
    ctx.state.watch(trainingCalendarState, ({ entries }) => {
      calendar = entries.get(PROVIDER)?.data?.workouts ?? [];
      draw();
    }),
    ctx.onBack(close),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
