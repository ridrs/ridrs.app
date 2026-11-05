// SPDX-License-Identifier: Apache-2.0

import { capabilityIdSchema } from './manifest-ids.ts';

export type CapabilityCardinality = 'single' | 'multiple';

export interface CapabilityOptions<
  TCardinality extends CapabilityCardinality = CapabilityCardinality,
> {
  readonly cardinality: TCardinality;
}

export interface CapabilityContract<
  TImpl = unknown,
  TCardinality extends CapabilityCardinality = CapabilityCardinality,
  TId extends string = string,
> {
  readonly id: TId;
  readonly cardinality: TCardinality;
  readonly __type?: TImpl;
}

export function defineCapability<
  TImpl,
  TCardinality extends CapabilityCardinality = 'single',
  TId extends string = string,
>(id: TId, options: CapabilityOptions<TCardinality>): CapabilityContract<TImpl, TCardinality, TId> {
  const parsedId = capabilityIdSchema.parse(id);
  return Object.freeze({
    id: parsedId as TId,
    cardinality: options.cardinality,
  });
}

export interface PluginCapabilitiesContext {
  provide<TImpl>(
    contract: CapabilityContract<TImpl, CapabilityCardinality>,
    implementation: TImpl,
  ): void;
  get<TImpl>(contract: CapabilityContract<TImpl, 'single'>): TImpl;
  /** A capability of `optionalRequires` (or `requires`): its provider, or undefined without one. */
  find<TImpl>(contract: CapabilityContract<TImpl, 'single'>): TImpl | undefined;
  getAll<TImpl>(contract: CapabilityContract<TImpl, 'multiple'>): readonly TImpl[];
}
