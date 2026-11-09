// SPDX-License-Identifier: AGPL-3.0-or-later

/** One line the page logged, or an error it did not catch. */
export interface DebugLog {
  readonly n: number;
  readonly level: string;
  readonly text: string;
}

export interface EvalResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

const MAX_LOGS = 500;

/**
 * The state of the debug bridge between a caller (an `eval` request) and the page (which answers
 * over the dev server's socket): the requests waiting for an answer and the page's last log lines.
 * No I/O here, so it is tested without a server.
 */
export class DebugRelay {
  private nextId = 1;
  private nextLog = 1;
  private readonly waiting = new Map<number, (result: EvalResult) => void>();
  private readonly lines: DebugLog[] = [];

  /** Sends `code` to the page with `send` and resolves with its answer, or fails after `timeoutMs`. */
  evaluate(
    code: string,
    send: (id: number, code: string) => void,
    timeoutMs = 10_000,
  ): Promise<EvalResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: `The page did not answer within ${timeoutMs} ms` });
      }, timeoutMs);
      this.waiting.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      send(id, code);
    });
  }

  /** The page's answer to request `id`; an answer nobody waits for any more is dropped. */
  answer(id: number, result: EvalResult): void {
    const resolve = this.waiting.get(id);
    this.waiting.delete(id);
    resolve?.(result);
  }

  log(level: string, text: string): void {
    this.lines.push({ n: this.nextLog++, level, text });
    if (this.lines.length > MAX_LOGS) {
      this.lines.shift();
    }
  }

  /** The lines after number `since` (all kept lines without it), oldest first. */
  logs(since = 0): DebugLog[] {
    return this.lines.filter((line) => line.n > since);
  }
}

/**
 * Whether a request may use the bridge: it carries the token, and it does not come from a web
 * page (a browser adds `Origin` to cross-site requests), so no site open in the user's browser can
 * run code in the app through the dev server's port.
 */
export function allowed(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  token: string,
): boolean {
  return headers['x-ridrs-debug-token'] === token && headers.origin === undefined;
}
