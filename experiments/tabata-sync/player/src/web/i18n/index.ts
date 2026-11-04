// SPDX-License-Identifier: AGPL-3.0-or-later

import { en, type MessageKey } from './en.ts';

const messages: Record<MessageKey, string> = en;

/** Looks up a UI string and fills `{name}` placeholders. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
