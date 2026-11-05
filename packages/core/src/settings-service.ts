// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AppFiles,
  type Diagnostic,
  type PluginManifest,
  type PluginSettingsContext,
  RidrsError,
  type ScopedSettings,
  type SettingsDocument,
} from '@ridrs/contracts';

const DOCUMENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The stored form of a settings document. */
interface StoredDocument {
  readonly version: number;
  readonly value: unknown;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Absent and unreadable look alike to the storage: an unreadable file has bytes that do not parse. */
async function readText(files: AppFiles, path: string): Promise<string | undefined> {
  const entries = await files.list(path.slice(0, path.lastIndexOf('/')));
  if (!entries.some((entry) => entry.path === path)) {
    return undefined;
  }
  return new TextDecoder().decode(await files.read(path));
}

/**
 * `ctx.settings` (ADR 0054): JSON documents at `config/machine/<plugin id>/<name>.json` in the
 * host's app files, looked up on every call. Without files (a replay), nothing is read or written.
 */
export function createPluginSettings(
  manifest: Readonly<PluginManifest>,
  filesOf: () => AppFiles | undefined,
  report: (diagnostic: Diagnostic) => void,
): PluginSettingsContext {
  /** Writes of one document run one after another. */
  const chains = new Map<string, Promise<void>>();

  const machine = <T>(document: SettingsDocument<T>): ScopedSettings<T> => {
    if (!manifest.persistence?.includes('machine')) {
      throw new RidrsError(
        'permission-denied',
        `Plugin "${manifest.id}" called "ctx.settings.machine" without "persistence": ["machine"] in its manifest`,
        { pluginId: manifest.id },
      );
    }
    if (!DOCUMENT_NAME.test(document.name)) {
      throw new RidrsError('invalid-path', `Invalid settings document name "${document.name}"`, {
        pluginId: manifest.id,
      });
    }
    const path = `config/machine/${manifest.id}/${document.name}.json`;
    const invalid = (message: string): undefined => {
      report({
        code: 'settings-invalid',
        pluginId: manifest.id,
        message: `The settings "${document.name}" of "${manifest.id}" cannot be used: ${message}`,
        details: { document: document.name, file: path },
      });
      return undefined;
    };

    return Object.freeze({
      async read(): Promise<T | undefined> {
        const files = filesOf();
        if (!files) {
          return undefined;
        }
        let stored: StoredDocument;
        try {
          const text = await readText(files, path);
          if (text === undefined) {
            return undefined;
          }
          stored = JSON.parse(text) as StoredDocument;
          if (typeof stored !== 'object' || stored === null || !Number.isInteger(stored.version)) {
            return invalid('no version');
          }
        } catch (error) {
          return invalid(reason(error));
        }
        let value = stored.value;
        if (stored.version > document.version) {
          return invalid(`version ${stored.version} is newer than ${document.version}`);
        }
        if (stored.version < document.version) {
          if (!document.migrate) {
            return invalid(`version ${stored.version} is older than ${document.version}`);
          }
          try {
            value = document.migrate(stored.version, value);
          } catch (error) {
            return invalid(reason(error));
          }
        }
        const parsed = document.schema.safeParse(value);
        return parsed.success ? parsed.data : invalid(parsed.error.message);
      },

      write(value: T): Promise<void> {
        const result = document.schema.safeParse(value);
        if (!result.success) {
          return Promise.reject(
            new RidrsError(
              'settings-invalid',
              `Invalid value for the settings "${document.name}" of "${manifest.id}": ${result.error.message}`,
              { pluginId: manifest.id },
            ),
          );
        }
        const parsed = result.data;
        const bytes = new TextEncoder().encode(
          `${JSON.stringify({ version: document.version, value: parsed } satisfies StoredDocument)}\n`,
        );
        const next = (chains.get(path) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => filesOf()?.replace(path, bytes));
        chains.set(path, next);
        return next;
      },
    });
  };

  return Object.freeze({ machine });
}
