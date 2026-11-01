<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0011: Controllable Time in Tests (`@sinonjs/fake-timers`)

Scenarios tagged `@fake-timers` install **@sinonjs/fake-timers** (15.4.0, BSD-3-Clause) in a `Before` hook and uninstall it in `After`. Only `Date`, `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` are faked (rxjs timers use `setInterval`). Time advances with `tickAsync`; the host clock of such scenarios is `Date.now()`. `nextTick`, `setImmediate` and `queueMicrotask` stay real.
