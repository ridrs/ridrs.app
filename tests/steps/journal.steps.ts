// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ActivityState } from '@ridrs/contracts';
import { OPEN_RECORDING_EXTENSION, parseRecording, type Recording } from '@ridrs/recording';
import type { RidrsWorld } from '../support/world.ts';
import { formatOffset, parseOffset } from './physics.steps.ts';

/** The text of the one open recording in the memory storage. */
export function openRecordingText(world: RidrsWorld): { path: string; text: string } {
  assert.ok(world.memoryFiles, 'Expected the memory storage');
  const open = [...world.memoryFiles.files].filter(([path]) =>
    path.endsWith(OPEN_RECORDING_EXTENSION),
  );
  assert.equal(open.length, 1, `Open recordings: ${open.map(([p]) => p).join(', ')}`);
  const [path, bytes] = open[0] as [string, Uint8Array];
  return { path, text: new TextDecoder().decode(bytes) };
}

function openRecording(world: RidrsWorld): Recording {
  return parseRecording(openRecordingText(world).text, {
    allowTornLastLine: true,
    requireFooter: false,
  });
}

When('the machine loses power', async function (this: RidrsWorld) {
  assert.ok(this.memoryFiles, 'Expected the memory storage');
  this.memoryFiles.losePower();
  // The host is gone with the power; what it still tries to write fails.
  await this.disposeHost();
  this.memoryFiles.powerRestored();
});

Then(
  'the open recording on the disk holds the {string} state of the ride',
  function (this: RidrsWorld, state: string) {
    const states = openRecording(this)
      .events.filter((e) => e.envelope.type === 'activity.state-changed')
      .map((e) => (e.envelope.payload as ActivityState).state);
    assert.ok(states.includes(state as ActivityState['state']), `States: ${states.join(', ')}`);
  },
);

Then(
  'the open recording on the disk holds the ride up to at least {string}',
  function (this: RidrsWorld, offset: string) {
    const last = openRecording(this).events.at(-1)?.envelope.timestamp ?? 0;
    assert.ok(last >= parseOffset(offset), `The disk holds the ride up to ${formatOffset(last)}`);
  },
);

Then('every line of the open recording on the disk is complete', function (this: RidrsWorld) {
  const { text } = openRecordingText(this);
  assert.ok(text.endsWith('\n'), 'The last line is torn');
  for (const line of text.split('\n').filter(Boolean)) {
    JSON.parse(line);
  }
});
