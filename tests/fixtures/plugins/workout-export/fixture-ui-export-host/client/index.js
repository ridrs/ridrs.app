// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): lists the fixture library as buttons and opens the export
// of one in place of the list, as the details do with their "Export" button: it draws
// `ui.workout-export`, closes it on `closed` and gives the focus back to the button that opened it.
import { trainingLibraryState, workoutExportCapability } from '@ridrs/contracts';

const PROVIDER = 'fixture-library';

export function ExportHost(container, ctx) {
  const list = document.createElement('div');
  list.dataset.testid = 'fixture-workouts';
  const place = document.createElement('div');
  place.dataset.testid = 'fixture-export-place';
  container.append(list);
  let library = [];
  let open;

  const draw = () => {
    list.replaceChildren(
      ...library.map((workout) => {
        const element = document.createElement('button');
        element.textContent = workout.name;
        element.addEventListener('click', () =>
          show({ from: PROVIDER, workoutId: workout.id }, workout.name),
        );
        return element;
      }),
    );
  };
  const show = (subject, label) => {
    list.remove();
    container.append(place);
    const handle = ctx.render(workoutExportCapability, place, subject);
    handle.onAvailability((available) => {
      if (!available) place.textContent = 'No export here';
    });
    handle.on('closed', close);
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
    ctx.onBack(close),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
