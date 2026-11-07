// SPDX-License-Identifier: AGPL-3.0-or-later

// Stage 0 of ridrs_elephant/prompts/14-app-state-and-services.md: app commands and app state in
// a ride's journal (ADR 0068).

import assert from 'node:assert/strict';
import { Given, Then } from '@cucumber/cucumber';
import {
  bridgePairService,
  type RouteOffer,
  routeFetchService,
  routeOfferState,
  trainingAccountState,
  trainingUploadService,
} from '@ridrs/contracts';
import { OPEN_RECORDING_EXTENSION, parseRecording } from '@ridrs/recording';
import { TEST_DEVICE_CHANNELS } from '../support/device-links.ts';
import type { RidrsWorld } from '../support/world.ts';

/** A video route of a probe source, `received` bytes of 1000 on their way. */
function probeOffer(id: string, received?: number): RouteOffer {
  return {
    id,
    kind: 'video',
    title: 'Col de Pennes',
    distance: 46_100,
    ascent: 1216,
    tags: {},
    availability:
      received === undefined
        ? { state: 'fetchable', size: 1000 }
        : { state: 'fetching', received, size: 1000 },
    world: { landscape: 'ui-world-video/landscape', route: id },
  };
}

/** The route the probe source offers. */
const probeRoutes = new WeakMap<RidrsWorld, string>();

Given(
  '{string} is a probe plugin that offers the route {string} and the training account {string}, and answers {string} and {string}',
  async function (
    this: RidrsWorld,
    probeId: string,
    route: string,
    account: string,
    fetch: string,
    upload: string,
  ) {
    assert.deepEqual([fetch, upload], [routeFetchService.id, trainingUploadService.id]);
    probeRoutes.set(this, route);
    // A transport plugin: an app service, started on continuation like every other plugin.
    await this.writeProbePluginFolder({
      folder: probeId,
      id: probeId,
      types: ['transport'],
      state: { owns: [routeOfferState.id, trainingAccountState.id] },
      services: { provides: [routeFetchService.id, trainingUploadService.id] },
    });
    const handled = (service: string) => (request: unknown) => {
      const calls = this.serviceCalls.get(probeId) ?? [];
      calls.push({ service, request });
      this.serviceCalls.set(probeId, calls);
      return {};
    };
    this.getBehavior(probeId).onStart.push((ctx) => {
      ctx.state.set(routeOfferState, route, probeOffer(route));
      ctx.state.set(trainingAccountState, account, {
        service: 'intervals.icu',
        state: 'connected',
      });
      ctx.services.provide(routeFetchService, handled(fetch));
      ctx.services.provide(trainingUploadService, handled(upload));
    });
  },
);

for (const verb of ['publishes', 'published']) {
  Given(
    `{string} ${verb} {string} with {string} through the UI bridge`,
    async function (this: RidrsWorld, _probe: string, eventId: string, payload: string) {
      this.ensureHost().publishEvent(
        'ui-bridge',
        this.getEventDefinition(eventId),
        JSON.parse(payload),
      );
      await this.settle();
    },
  );
}

Given(
  '{string} reported the progress of its route {int} times',
  async function (this: RidrsWorld, probeId: string, times: number) {
    const ctx = this.ensureHost().getPluginContext(probeId);
    const route = probeRoutes.get(this);
    assert.ok(ctx && route, `Expected plugin "${probeId}" to be running with its route`);
    // As a route provider reports the progress of a download: one key of the app state.
    for (let i = 1; i <= times; i += 1) {
      ctx.state.set(routeOfferState, route, probeOffer(route, i * 100));
      await this.flushState();
    }
  },
);

Then(
  '{string} received the {string} only once',
  function (this: RidrsWorld, probeId: string, eventId: string) {
    // An app command as an event (stage 0) or as a service call (ADR 0068).
    const received = [
      ...(this.receivedEvents.get(probeId) ?? []).filter((e) => e.type === eventId),
      ...(this.serviceCalls.get(probeId) ?? []).filter((c) => c.service === eventId),
    ];
    assert.equal(
      received.length,
      1,
      `"${probeId}" received "${eventId}" ${received.length} times: once in the ride, again when it continued`,
    );
  },
);

Then(
  'the open recording on the disk holds no {string} event',
  function (this: RidrsWorld, eventId: string) {
    assert.ok(this.memoryFiles, 'Expected the memory storage');
    const open = [...this.memoryFiles.files].find(([path]) =>
      path.endsWith(OPEN_RECORDING_EXTENSION),
    );
    assert.ok(open, 'Expected an open recording');
    const recording = parseRecording(new TextDecoder().decode(open[1]), {
      allowTornLastLine: true,
      requireFooter: false,
    });
    const found = recording.events.filter((e) => e.envelope.type === eventId).length;
    assert.equal(found, 0, `The recording holds ${found} "${eventId}" events`);
  },
);

Given(
  '{string} is a probe device plugin that answers {string}',
  async function (this: RidrsWorld, probeId: string, serviceId: string) {
    assert.equal(serviceId, bridgePairService.id);
    // A device plugin: it runs in a continued ride (and in a replay) like the real ones.
    await this.writeProbePluginFolder({
      folder: probeId,
      id: probeId,
      types: ['device'],
      state: { owns: [...TEST_DEVICE_CHANNELS.state.owns] },
      services: { provides: [...TEST_DEVICE_CHANNELS.services.provides, serviceId] },
    });
    this.getBehavior(probeId).onStart.push((ctx) => {
      ctx.services.provide(bridgePairService, (request) => {
        const calls = this.serviceCalls.get(probeId) ?? [];
        calls.push({ service: serviceId, request });
        this.serviceCalls.set(probeId, calls);
        return {};
      });
    });
  },
);

Then(
  'the open recording on the disk does not contain {string}',
  function (this: RidrsWorld, text: string) {
    assert.ok(this.memoryFiles, 'Expected the memory storage');
    const open = [...this.memoryFiles.files].find(([path]) =>
      path.endsWith(OPEN_RECORDING_EXTENSION),
    );
    assert.ok(open, 'Expected an open recording');
    assert.ok(!new TextDecoder().decode(open[1]).includes(text), `The recording holds "${text}"`);
  },
);

/** The FIT files written so far, in the order of their first write. */
const fitFiles = (world: RidrsWorld) =>
  [...(world.memoryFiles?.writes.keys() ?? [])].filter((path) => path.endsWith('.fit'));

Given('the FIT file of that ride was written', async function (this: RidrsWorld) {
  await this.waitForIo(() => fitFiles(this).length > 0, 'the FIT file');
});

Then('the FIT file of the first ride was written only once', async function (this: RidrsWorld) {
  // An export runs on real I/O turns: give a second one the time it would need.
  for (let turn = 0; turn < 200; turn += 1) {
    await this.settle();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [first] = fitFiles(this);
  assert.ok(first, 'Expected a FIT file');
  assert.equal(
    this.memoryFiles?.writes.get(first),
    1,
    `"${first}" was written ${this.memoryFiles?.writes.get(first)} times`,
  );
});
