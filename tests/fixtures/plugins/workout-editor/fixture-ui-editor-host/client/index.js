// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): lists the `ridrs` library as buttons, opens the details
// of one, and has a "New workout" button that draws the editor in place of the list, as the
// Training area does. `closed` and `back` bring the list back.
import {
  trainingLibraryState,
  workoutDetailsCapability,
  workoutEditorCapability,
} from '@ridrs/contracts';

export function EditorHost(container, ctx) {
  const list = document.createElement('div');
  list.dataset.testid = 'fixture-library-list';
  const place = document.createElement('div');
  container.append(list);
  let library = [];
  let open;

  const draw = () => {
    const create = document.createElement('button');
    create.textContent = 'New workout';
    create.addEventListener('click', () => showEditor());
    list.replaceChildren(
      create,
      ...library.map((workout) => {
        const element = document.createElement('button');
        element.textContent = workout.name;
        element.dataset.workoutId = workout.id;
        element.addEventListener('click', () => showDetails(workout.id));
        return element;
      }),
    );
  };
  const show = (handle) => {
    list.remove();
    container.append(place);
    open = handle;
  };
  const close = () => {
    if (!open) return;
    open.release();
    open = undefined;
    place.remove();
    container.append(list);
  };
  const showDetails = (workoutId) => {
    const handle = ctx.render(workoutDetailsCapability, place, {
      kind: 'library',
      from: 'ridrs',
      workoutId,
    });
    handle.on('back', close);
    show(handle);
  };
  const showEditor = () => {
    const handle = ctx.render(workoutEditorCapability, place, { kind: 'new' });
    handle.on('saved', close);
    handle.on('closed', close);
    show(handle);
  };

  const stop = ctx.state.watch(trainingLibraryState, ({ entries }) => {
    library = entries.get('ridrs')?.data?.workouts ?? [];
    draw();
  });
  const stopBack = ctx.onBack(close);
  return () => {
    stop();
    stopBack();
  };
}
