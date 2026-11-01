// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PluginLogFn, PluginLogger } from '@ridrs/contracts';

type ConsoleLevel = 'debug' | 'info' | 'warn' | 'error';

/** Logger port adapter that discards everything; the default when a host gets no logger. */
export function createSilentLogger(): PluginLogger {
  const ignore: PluginLogFn = () => undefined;
  const logger: PluginLogger = {
    debug: ignore,
    info: ignore,
    warn: ignore,
    error: ignore,
    child: () => logger,
  };
  return logger;
}

/**
 * Logger port adapter for hosts without pino (the native app's WebView): structured bindings are
 * passed to the console as an object next to the message.
 */
export function createConsoleLogger(
  bindings: Readonly<Record<string, unknown>> = {},
  target: Pick<Console, ConsoleLevel> = console,
): PluginLogger {
  const at =
    (level: ConsoleLevel): PluginLogFn =>
    (first: string | Readonly<Record<string, unknown>>, message?: string) => {
      if (typeof first === 'string') {
        target[level](first, bindings);
      } else {
        target[level](message ?? '', { ...bindings, ...first });
      }
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (more) => createConsoleLogger({ ...bindings, ...more }, target),
  };
}
