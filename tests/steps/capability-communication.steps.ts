// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { type CapabilityContract, RidrsError } from '@ridrs/contracts';
import type { RidrsWorld } from '../support/world.ts';

interface DemoClock {
  tellTime(): string;
}

interface DemoGreeter {
  greet(name: string): string;
}

Given(
  '{string} implements {string} telling the time {string}',
  function (this: RidrsWorld, pluginId: string, capabilityId: string, timeText: string) {
    const impl: DemoClock = {
      tellTime: () => timeText,
    };
    this.getBehavior(pluginId).providedImplementations.set(capabilityId, impl);
  },
);

Given(
  '{string} implements {string} greeting with {string}',
  function (this: RidrsWorld, pluginId: string, capabilityId: string, greetingPrefix: string) {
    const impl: DemoGreeter = {
      greet: (name: string) => `${greetingPrefix}, ${name}`,
    };
    this.getBehavior(pluginId).providedImplementations.set(capabilityId, impl);
  },
);

Given(
  '{string} also tries to implement {string} during initialize',
  function (this: RidrsWorld, pluginId: string, capabilityId: string) {
    const impl: DemoGreeter = {
      greet: (name: string) => `Hi, ${name}`,
    };
    this.getBehavior(pluginId).extraProvideCapabilities.set(capabilityId, impl);
  },
);

Given(
  '{string} does not implement {string} during initialize',
  function (this: RidrsWorld, pluginId: string, capabilityId: string) {
    this.getBehavior(pluginId).skipProvideCapabilities.add(capabilityId);
  },
);

When(
  '{string} asks {string} for the time',
  function (this: RidrsWorld, pluginId: string, capabilityId: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const contract = this.getOrRegisterCapability(capabilityId, 'single') as CapabilityContract<
      DemoClock,
      'single'
    >;

    this.lastCapabilityError = undefined;
    try {
      const clock = ctx.capabilities.get(contract);
      this.capabilityAnswers.set(pluginId, clock.tellTime());
    } catch (error) {
      this.lastCapabilityError = error;
    }
  },
);

When(
  '{string} asks every {string} to greet {string}',
  function (this: RidrsWorld, pluginId: string, capabilityId: string, name: string) {
    const host = this.ensureHost();
    const ctx = host.getPluginContext(pluginId);
    assert.ok(ctx, `Expected context for plugin "${pluginId}"`);
    const contract = this.getOrRegisterCapability(capabilityId, 'multiple') as CapabilityContract<
      DemoGreeter,
      'multiple'
    >;

    this.lastCapabilityError = undefined;
    try {
      const greeters = ctx.capabilities.getAll(contract);
      const greetings = greeters.map((g) => g.greet(name)).join('; ');
      this.capabilityAnswers.set(pluginId, greetings);
    } catch (error) {
      this.lastCapabilityError = error;
    }
  },
);

Then(
  '{string} gets the answer(s) {string}',
  function (this: RidrsWorld, pluginId: string, expectedAnswer: string) {
    assert.equal(this.lastCapabilityError, undefined);
    assert.equal(this.capabilityAnswers.get(pluginId), expectedAnswer);
  },
);

Then(
  'the request is refused with a(n) {string} error',
  function (this: RidrsWorld, expectedCode: string) {
    assert.ok(this.lastCapabilityError instanceof RidrsError, 'Expected a RidrsError');
    assert.equal(this.lastCapabilityError.code, expectedCode);
  },
);
