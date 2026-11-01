// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const pluginIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const dottedIdPattern = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

export const pluginIdSchema = z
  .string()
  .regex(pluginIdPattern, 'Must be lowercase kebab-case (e.g. "example-ping")');

export const capabilityIdSchema = z
  .string()
  .regex(dottedIdPattern, 'Must be a lowercase dotted identifier (e.g. "demo.clock")');

export const eventIdSchema = z
  .string()
  .regex(dottedIdPattern, 'Must be a lowercase dotted identifier (e.g. "core.host.started")');
