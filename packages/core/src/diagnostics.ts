// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Diagnostic } from '@ridrs/contracts';
import type { Logger } from 'pino';

export class DiagnosticCollector {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  report(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
    this.logger.warn(
      {
        code: diagnostic.code,
        pluginId: diagnostic.pluginId,
        folder: diagnostic.folder,
        details: diagnostic.details,
      },
      diagnostic.message,
    );
  }

  getAll(): readonly Diagnostic[] {
    return [...this.diagnostics];
  }
}
