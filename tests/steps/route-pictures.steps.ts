// SPDX-License-Identifier: AGPL-3.0-or-later

import { Given } from '@cucumber/cucumber';
import { simulatedPicture } from '../support/simulated-picture.ts';
import type { RidrsWorld } from '../support/world.ts';

Given(
  'pictures are made smaller by the simulated picture provider',
  async function (this: RidrsWorld) {
    this.getBehavior('simulated-picture').providedImplementations.set(
      'data.picture',
      simulatedPicture,
    );
    await this.writeProbePluginFolder({
      folder: 'simulated-picture',
      id: 'simulated-picture',
      types: ['test'],
      provides: ['data.picture'],
    });
  },
);
