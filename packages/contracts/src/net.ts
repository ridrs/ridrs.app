// SPDX-License-Identifier: Apache-2.0

import { defineCapability } from './capabilities.ts';

/**
 * HTTP to the services ridrs connects to (ADR 0048). The provider decides how requests leave
 * the app (Rust in the native app) and which URLs it allows. A network failure rejects; any
 * HTTP status resolves.
 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** As text, so that a provider can carry it across a process boundary; callers parse it. */
  readonly body: string;
}

export const netHttpCapability = defineCapability<HttpClient, 'single', 'net.http'>('net.http', {
  cardinality: 'single',
});
