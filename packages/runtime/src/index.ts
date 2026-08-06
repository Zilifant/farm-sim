// @sim/runtime — reusable simulation infrastructure.
// Phases 1–2: single-threaded deterministic core plus workers, batched
// messaging, and the transfer path. SAB memory sharing and snapshots land in
// later phases.

export const RUNTIME_NAME = "@sim/runtime";

export * from "./clock/fixed-step-clock.js";
export * from "./events/queue.js";
export * from "./memory/buffer-registry.js";
export * from "./memory/hash.js";
export * from "./messaging/command-buffer.js";
export * from "./messaging/transfer.js";
export * from "./messaging/types.js";
export * from "./profile/profiler.js";
export * from "./rng/counter.js";
export * from "./rng/stream.js";
export * from "./schedule/executor.js";
export * from "./schedule/scheduler.js";
export * from "./schedule/types.js";
export * from "./workers/handle.js";
export * from "./workers/node-adapter.js";
export * from "./workers/pool.js";
export * from "./workers/serve.js";
export * from "./workers/test-adapter.js";
export * from "./workers/types.js";
