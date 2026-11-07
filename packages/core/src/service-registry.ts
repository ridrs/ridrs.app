// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type EventSubscription,
  RidrsError,
  type ServiceCaller,
  type ServiceDefinition,
  type ServiceHandler,
} from '@ridrs/contracts';
import type { StateStore } from './state-store.ts';

/** One finished call: its answer, or the message of its error. */
export interface ServiceCallRecord {
  readonly service: string;
  readonly caller: string;
  readonly request: unknown;
  readonly response?: unknown;
  readonly error?: string;
}

export type ServiceCallObserver = (call: ServiceCallRecord) => void;

export interface ServiceRegistryOptions {
  /** Where keyed services find the owner of `request.key`. */
  readonly store: StateStore;
}

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(value)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Services beside the bus (ADR 0068): providers by service id, one for a service without a key,
 * the key's owner for a keyed one. Validates requests and answers; a handler runs after a
 * microtask, never inside a turn or its caller. Never recorded. Knows no service.
 */
export class ServiceRegistry {
  private readonly definitions = new Map<string, ServiceDefinition>();
  /** Service id -> plugin id -> handler. */
  private readonly providers = new Map<string, Map<string, ServiceHandler<unknown, unknown>>>();
  private readonly observers = new Set<ServiceCallObserver>();

  constructor(private readonly options: ServiceRegistryOptions) {}

  register(definitions: Iterable<ServiceDefinition>): void {
    for (const definition of definitions) {
      this.definitions.set(definition.id, definition);
    }
  }

  definitionsById(): ReadonlyMap<string, ServiceDefinition> {
    return new Map(this.definitions);
  }

  provide<Req, Res>(
    pluginId: string,
    service: ServiceDefinition<Req, Res>,
    handler: ServiceHandler<Req, Res>,
  ): void {
    const definition = this.definitions.get(service.id);
    if (!definition) {
      throw new RidrsError('unknown-service', `No service "${service.id}" is registered`, {
        pluginId,
      });
    }
    const providers = this.providers.get(service.id) ?? new Map();
    const other = [...providers.keys()].find((id) => id !== pluginId);
    if (!definition.keyedBy && other !== undefined) {
      throw new RidrsError(
        'ambiguous-service',
        `Plugin "${pluginId}" cannot provide "${service.id}": plugin "${other}" provides it and it has no key`,
        { pluginId },
      );
    }
    providers.set(pluginId, handler as ServiceHandler<unknown, unknown>);
    this.providers.set(service.id, providers);
  }

  /** Every finished call, read-only (composition roots, tests). */
  observe(observer: ServiceCallObserver): EventSubscription {
    this.observers.add(observer);
    return { unsubscribe: () => this.observers.delete(observer) };
  }

  async call(serviceId: string, request: unknown, caller: ServiceCaller): Promise<unknown> {
    try {
      const response = await this.answer(serviceId, request, caller);
      this.tell({ service: serviceId, caller: caller.pluginId, request, response });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tell({ service: serviceId, caller: caller.pluginId, request, error: message });
      throw error;
    }
  }

  private tell(call: ServiceCallRecord): void {
    for (const observer of [...this.observers]) {
      observer(call);
    }
  }

  private async answer(
    serviceId: string,
    request: unknown,
    caller: ServiceCaller,
  ): Promise<unknown> {
    const definition = this.definitions.get(serviceId);
    if (!definition) {
      throw new RidrsError('unknown-service', `No service "${serviceId}" is registered`);
    }
    const parsed = definition.request.safeParse(request);
    if (!parsed.success) {
      throw new RidrsError(
        'invalid-request',
        `Invalid request for "${serviceId}": ${issuesOf(parsed.error)}`,
      );
    }
    const providers = this.providers.get(serviceId) ?? new Map();
    let providerId: string | undefined;
    if (definition.keyedBy) {
      const key = (parsed.data as { key: string }).key;
      providerId = this.options.store.ownerOf(definition.keyedBy.id, key);
      if (providerId === undefined) {
        throw new RidrsError(
          'unknown-key',
          `No plugin owns "${key}" in "${definition.keyedBy.id}" to answer "${serviceId}"`,
        );
      }
    } else {
      providerId = [...providers.keys()][0];
    }
    const handler = providerId === undefined ? undefined : providers.get(providerId);
    if (!handler || providerId === undefined) {
      throw new RidrsError(
        'service-unavailable',
        providerId === undefined
          ? `No plugin provides "${serviceId}"`
          : `Plugin "${providerId}" does not provide "${serviceId}"`,
      );
    }
    // Never inside the caller, so never inside a turn.
    await Promise.resolve();
    let response: unknown;
    try {
      response = await handler(parsed.data, caller);
    } catch (error) {
      if (error instanceof RidrsError) {
        throw error;
      }
      throw new RidrsError(
        'service-failed',
        error instanceof Error ? error.message : String(error),
        { pluginId: providerId, cause: error },
      );
    }
    const answer = definition.response.safeParse(response);
    if (!answer.success) {
      throw new RidrsError(
        'invalid-response',
        `Plugin "${providerId}" answered "${serviceId}" with an invalid response: ${issuesOf(answer.error)}`,
        { pluginId: providerId },
      );
    }
    return answer.data;
  }

  /** A stopped plugin provides nothing any more. */
  releasePlugin(pluginId: string): void {
    for (const providers of this.providers.values()) {
      providers.delete(pluginId);
    }
  }
}
