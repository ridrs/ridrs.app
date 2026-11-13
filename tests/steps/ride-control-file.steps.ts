// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { videoRouteSchema } from '@ridrs/contracts';
import { type Control, controlFromRoute, parseControl, pictureOf, writeControl } from '@ridrs/ride';
import { splitCsv } from './devices-and-metrics.steps.ts';

interface Scene {
  text?: string;
  control?: Control;
  route?: ReturnType<typeof videoRouteSchema.parse>;
}

const scenes = new WeakMap<object, Scene>();

function scene(world: object): Scene {
  let found = scenes.get(world);
  if (!found) {
    found = {};
    scenes.set(world, found);
  }
  return found;
}

function control(world: object): Control {
  const read = scene(world).control;
  assert.ok(read, 'Expected the control file to have been read');
  return read;
}

/** `\n` in a step's text is a line break, as in the notes of a control file. */
const lines = (text: string) => text.replaceAll('\\n', '\n');

Given('the control file', function (this: object, text: string) {
  scene(this).text = text;
});

Given('the route in the unified format', function (this: object, json: string) {
  scene(this).route = videoRouteSchema.parse(JSON.parse(json));
});

When('a control file is written for it', function (this: object) {
  const route = scene(this).route;
  assert.ok(route, 'Expected a route in the unified format');
  scene(this).text = writeControl(controlFromRoute(route));
});

When('the control file is read', function (this: object) {
  const text = scene(this).text;
  assert.ok(text !== undefined, 'Expected a control file');
  scene(this).control = parseControl(text);
});

Then("the route's title is {string}", function (this: object, title: string) {
  assert.equal(control(this).title, title);
});

Then('the route has no title', function (this: object) {
  assert.equal(control(this).title, undefined);
});

Then("the route's name is {string}", function (this: object, name: string) {
  assert.equal(control(this).name, name);
});

Then("the route's frame rate is {float}", function (this: object, framerate: number) {
  assert.equal(control(this).framerate, framerate);
});

Then(
  "the route's video is {string} at {float} frames per second from frame {int}",
  function (this: object, video: string, framerate: number, startFrame: number) {
    const read = control(this);
    assert.deepEqual([read.video, read.framerate, read.startFrame], [video, framerate, startFrame]);
  },
);

Then("the route's track is {string}", function (this: object, gpx: string) {
  assert.equal(control(this).gpx, gpx);
});

Then("the route's picture is named {string}", function (this: object, preview: string) {
  assert.equal(control(this).preview, preview);
});

Then(
  "among the files {string} the route's picture is {string}",
  function (this: object, files: string, picture: string) {
    assert.equal(pictureOf(control(this), splitCsv(files)), picture);
  },
);

Then('among the files {string} the route has no picture', function (this: object, files: string) {
  assert.equal(pictureOf(control(this), splitCsv(files)), undefined);
});

Then(
  "the route's note at {int} m reads {string} in {string}",
  function (this: object, distance: number, text: string, language: string) {
    const note = control(this).notes.find((candidate) => candidate.distance === distance);
    assert.equal(note?.text[language], lines(text));
  },
);

Then(
  "the route's segment {string} runs from {int} m to {int} m",
  function (this: object, name: string, start: number, end: number) {
    const segment = control(this).segments.find((candidate) => candidate.name === name);
    assert.deepEqual(segment && [segment.start, segment.end], [start, end]);
  },
);
