// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Diagnostic, PluginLogger } from '@ridrs/contracts';

export class DiagnosticCollector {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly logger: PluginLogger;
  private readonly listeners = new Set<(diagnostic: Diagnostic) => void>();

  constructor(logger: PluginLogger) {
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
    for (const listener of [...this.listeners]) {
      try {
        listener(diagnostic);
      } catch (error) {
        // A failing listener must not turn into a diagnostic about itself, endlessly.
        this.logger.error({ err: error }, 'Diagnostic listener failed');
      }
    }
  }

  /** Called for every diagnostic reported from now on. */
  onReport(listener: (diagnostic: Diagnostic) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getAll(): readonly Diagnostic[] {
    return [...this.diagnostics];
  }
}
