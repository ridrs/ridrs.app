// SPDX-License-Identifier: Apache-2.0

export type DiagnosticCode =
  | 'missing-manifest'
  | 'invalid-manifest'
  | 'duplicate-id'
  | 'missing-capability'
  | 'unknown-capability'
  | 'ambiguous-provider'
  | 'dependency-cycle'
  | 'entry-load-failure'
  | 'lifecycle-failure'
  | 'capability-not-provided'
  | 'undeclared-capability'
  | 'event-handler-failure';

export type RidrsErrorCode = DiagnosticCode | 'invalid-event-payload' | 'plugin-not-active';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly pluginId?: string;
  readonly folder?: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class RidrsError extends Error {
  override readonly name = 'RidrsError';
  readonly code: RidrsErrorCode;
  readonly pluginId?: string;

  constructor(
    code: RidrsErrorCode,
    message: string,
    options?: { pluginId?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.pluginId = options?.pluginId;
  }
}
