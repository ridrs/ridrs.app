// SPDX-License-Identifier: AGPL-3.0-or-later

import { type InputHTMLAttributes, useRef, useState } from 'react';

/**
 * A text field that edits a value of another type: what is typed stays as typed while it means
 * the value (so "12:" or "7," can be completed), and the field follows the value when it changes
 * from outside (undo, a drag in the chart). `parse` answers `undefined` for text that means
 * nothing; then nothing is committed.
 */
export function Buffered<T>({
  value,
  show,
  parse,
  onCommit,
  label,
  invalid,
  ...rest
}: {
  readonly value: T;
  readonly show: (value: T) => string;
  readonly parse: (text: string) => { readonly value: T } | undefined;
  readonly onCommit: (value: T) => void;
  readonly label: string;
  readonly invalid?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'aria-label' | 'aria-invalid'>) {
  const [raw, setRaw] = useState(() => show(value));
  const known = useRef(show(value));
  const now = show(value);
  if (now !== known.current) {
    known.current = now;
    if (parse(raw) === undefined || show((parse(raw) as { value: T }).value) !== now) setRaw(now);
  }
  return (
    <input
      {...rest}
      aria-label={label}
      aria-invalid={invalid ? 'true' : undefined}
      value={raw}
      onChange={(event) => {
        setRaw(event.target.value);
        const parsed = parse(event.target.value);
        if (!parsed) return;
        known.current = show(parsed.value);
        onCommit(parsed.value);
      }}
    />
  );
}

export const parseNumber = (text: string): { value: number } | undefined => {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return undefined;
  return { value: Number(trimmed) };
};
