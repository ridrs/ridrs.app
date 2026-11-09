// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs in the page of the dev app (never in a build): reports what the page logs and runs the
// code the debug bridge sends. See debug-bridge/plugin.ts.

const hot = import.meta.hot;

/** A value as text the bridge can return: DOM nodes as their HTML, cycles and functions marked. */
function plain(value) {
  const seen = new WeakSet();
  const text = JSON.stringify(
    value,
    (_key, v) => {
      if (v instanceof Element) return v.outerHTML.slice(0, 2000);
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (typeof v === 'function') return `[function ${v.name}]`;
      if (typeof v === 'bigint') return `${v}n`;
      if (v !== null && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    },
    1,
  );
  return text === undefined ? undefined : JSON.parse(text.slice(0, 100_000));
}

const show = (value) => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(plain(value));
  } catch {
    return String(value);
  }
};

if (hot) {
  const log = (level, text) => hot.send('ridrs-debug:log', { level, text });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      log(level, args.map(show).join(' '));
    };
  }
  addEventListener('error', (event) =>
    log('uncaught', `${event.message} (${event.filename}:${event.lineno})`),
  );
  addEventListener('unhandledrejection', (event) =>
    log('uncaught', `unhandled rejection: ${show(event.reason)}`),
  );

  hot.on('ridrs-debug:eval', async ({ id, code }) => {
    try {
      // An async function body, so `await` and `return` work.
      const run = new (Object.getPrototypeOf(async () => undefined).constructor)(code);
      hot.send('ridrs-debug:result', { id, ok: true, value: plain(await run()) });
    } catch (error) {
      hot.send('ridrs-debug:result', { id, ok: false, error: show(error) });
    }
  });
  // Again after the dev server restarted: it knows no page then.
  const hello = () =>
    hot.send('ridrs-debug:hello', { userAgent: navigator.userAgent, href: location.href });
  hot.on('vite:ws:connect', hello);
  hello();
}
