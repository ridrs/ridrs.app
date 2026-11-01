// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSystemClock, PluginHost } from '@ridrs/core';
import pino from 'pino';

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      plugins: {
        type: 'string',
        short: 'p',
      },
    },
    strict: true,
  });

  const requestedDir = values.plugins ?? 'plugins';
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const resolvedFromBase = resolve(baseDir, requestedDir);
  const pluginsDir = existsSync(resolvedFromBase)
    ? resolvedFromBase
    : resolve(process.cwd(), requestedDir);

  const logger = pino({ name: 'ridrs-headless' }, pino.destination({ sync: true }));
  const host = new PluginHost({
    pluginsDir,
    clock: createSystemClock(),
    logger,
  });

  const keepAlive = setInterval(() => {}, 60_000);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(keepAlive);
    await host.dispose();
    logger.info('host stopped');
    logger.flush();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await host.start();

  const startedPlugins = host
    .getKnownPlugins()
    .map((m) => m.id)
    .filter((id) => host.getPluginState(id) === 'started');

  logger.info({ startedPlugins }, `host started (${startedPlugins.join(', ')})`);
}

main().catch((error: unknown) => {
  const logger = pino({ name: 'ridrs-headless' }, pino.destination({ sync: true }));
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: error }, `Fatal error starting headless host: ${message}`);
  logger.flush();
  process.exit(1);
});
