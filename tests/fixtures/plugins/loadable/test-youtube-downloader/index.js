// SPDX-License-Identifier: AGPL-3.0-or-later

// A plugin the rider installs (ADR 0106), as such a plugin comes: one ES module without imports.
// A downloader of YouTube videos for the scenarios: its one quality "Test" is downloaded by
// starting the program it was granted, `node`, through `process.run`.
const routeDownloader = { id: 'route.downloader', cardinality: 'multiple' };
const processRun = { id: 'process.run', cardinality: 'single' };

export default {
  initialize(ctx) {
    const run = ctx.capabilities.find(processRun);
    ctx.capabilities.provide(routeDownloader, {
      kinds: ['youtube'],
      open(changed) {
        const routes = new Map();
        const states = new Map();
        const sizeOf = (id) => routes.get(id)?.size ?? 1;
        return {
          async setRoutes(next) {
            routes.clear();
            for (const route of next) routes.set(route.id, route);
          },
          availability: (id) => states.get(id) ?? { state: 'fetchable', size: sizeOf(id) },
          pictures: () => ({}),
          refusal: () => (run ? undefined : 'This app cannot start programs'),
          options: async () => [{ id: 'test', label: 'Test' }],
          async fetch(id) {
            states.set(id, { state: 'fetching', received: 0, size: sizeOf(id) });
            changed(id);
            try {
              const { code } = await run.run({
                program: 'node',
                args: ['-e', 'console.log("fetched")'],
              });
              states.set(
                id,
                code === 0
                  ? { state: 'ready' }
                  : { state: 'failed', reason: `node ended with ${code}`, size: sizeOf(id) },
              );
            } catch (error) {
              states.set(id, {
                state: 'failed',
                reason: String(error?.message ?? error),
                size: sizeOf(id),
              });
            }
            changed(id);
          },
          cancel() {},
          async remove() {},
        };
      },
    });
  },
};
