// SPDX-License-Identifier: AGPL-3.0-or-later

// Hand-written client module (no build): lists the offers of the test topic and fetches one.
import { defineService, defineState } from '@ridrs/contracts';
import { z } from 'zod';

const offerState = defineState(
  'test.offer',
  z.object({ title: z.string(), progress: z.number().min(0).max(1).optional() }).strict(),
);
const fetchService = defineService('test.fetch', {
  request: z.object({ key: z.string() }).strict(),
  response: z.object({}).strict(),
  keyedBy: offerState,
});

export function Offers(container, ctx) {
  const list = document.createElement('ul');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  container.append(list, status);

  const render = (entries) => {
    list.replaceChildren(
      ...[...entries].map(([key, offer]) => {
        const item = document.createElement('li');
        const progress =
          offer.progress === undefined ? '' : ` ${Math.round(offer.progress * 100)} %`;
        item.textContent = `${key}: ${offer.title}${progress}`;
        const button = document.createElement('button');
        button.textContent = `Fetch ${key}`;
        button.addEventListener('click', () => {
          ctx.call(fetchService, { key }).then(
            () => {
              status.textContent = `Fetching ${key}`;
            },
            (error) => {
              status.textContent = `${error.code}: ${error.message}`;
            },
          );
        });
        item.append(button);
        return item;
      }),
    );
  };

  const stop = ctx.state.watch(offerState, ({ entries }) => render(entries));
  return stop;
}
