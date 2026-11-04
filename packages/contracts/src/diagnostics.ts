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
  | 'event-handler-failure'
  | 'malformed-packet'
  | 'multiple-sources'
  | 'late-measurement'
  | 'invalid-transition'
  | 'unknown-extension-point'
  | 'duplicate-screen'
  | 'duplicate-extension-point'
  | 'client-entry-missing'
  | 'client-load-failure'
  | 'bridge-unreachable'
  | 'bridge-rejected'
  | 'bridge-protocol-error'
  | 'physics-step-failed'
  | 'terrain-preview-missing'
  | 'terrain-preview-rejected'
  | 'recording-failed'
  | 'recording-recovered'
  | 'fit-export-failed'
  | 'config-snapshot-failed';

export type RidrsErrorCode =
  | DiagnosticCode
  | 'invalid-event-payload'
  | 'plugin-not-active'
  | 'event-not-allowed'
  | 'undeclared-event'
  | 'permission-denied'
  | 'outside-turn'
  | 'invalid-path'
  | 'sign-in-cancelled'
  | 'invalid-recording'
  | 'recording-unsupported-version';

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
