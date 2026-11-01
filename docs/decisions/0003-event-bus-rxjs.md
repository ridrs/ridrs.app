<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0003: Event Dispatch and Streams (`rxjs`)

We use **rxjs** (7.8.2, Apache-2.0) to implement the in-memory event bus using `Subject`, `Subscription`, and `queueScheduler`. Scheduling emissions on `queueScheduler` guarantees synchronous run-to-completion (FIFO) semantics when subscribers publish follow-up events during delivery, and `Subscription` provides composable teardown semantics for automatic per-plugin unsubscription when a plugin stops. RxJS is pure JavaScript, ESM-compatible, and will also power combined streams and temporal smoothing in later phases. Alternatives considered included Node's `EventEmitter` (lacks built-in breadth-first `queueScheduler` semantics and composable stream operators) and `mitt` (too minimal for stream composition in later phases).
