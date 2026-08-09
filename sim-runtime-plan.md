# TypeScript Simulation Runtime — Implementation Plan

> **Status: complete (2026-08).** All phases (0–8) are implemented and merged;
> this document is retired as a historical record — read it for provenance
> (why and when a decision was made), not for current state. The README and
> `docs/` describe what was actually built, including where the
> implementation deliberately deviates (notably: the Wa-Tor rules were
> redesigned in Phase 2 into a conflict-free "color-phase" update so results
> are identical across worker counts, which made §Phase 3's two-phase
> intent/resolve/apply pass unnecessary; grid dimensions must be multiples
> of 5 as a consequence). A browser ASCII renderer (not in this plan) was
> added afterward under `apps/server/renderer/`.

Stack: Node 24 LTS, TS + ESM, `node:worker_threads`, `MessagePort`, transferred `ArrayBuffer`, `SharedArrayBuffer` + `Atomics`, Express 5 (optional, isolated), Vitest, pnpm workspaces.

Guiding rule: build the runtime *inside* one reference simulation, extract afterward. Two packages until extraction is earned.

---

## 1. Monorepo Structure

```
sim/
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    runtime/              # @sim/runtime — all reusable infra (single package until Phase 7)
      src/
        clock/            # fixed timestep, pause, speed
        schedule/         # system scheduler, update frequencies
        workers/          # WorkerAdapter interface + NodeWorkerAdapter, pool
        memory/           # typed-array + SAB allocators, layouts
        messaging/        # command buffers, batched ports, transfer helpers
        rng/              # seeded streams
        events/           # event queues
        snapshot/         # save/load/replay, schema versioning
        profile/          # per-system timing
    refsim/               # @sim/refsim — Wa-Tor predator-prey (see §4)
  apps/
    server/               # Express 5 API — Phase 8 only, depends on @sim/runtime public API
```

pnpm over npm: workspace protocol + stricter node_modules catches phantom deps (7). Do not pre-split runtime into core/workers/memory packages — split only when a second real simulation forces it (8).

Worker entry files must be compiled JS or loaded via `tsx`/`--import` loader in `execArgv`; plan a build step (`tsc -b`) early so workers run plain ESM `.js` — the most common worker_threads + TS failure mode (8).

---

## 2. Core TypeScript Interfaces

Signatures only; no implementations yet.

```ts
// clock
interface SimClock {
  readonly tick: bigint;
  readonly fixedDtMs: number;        // e.g. 16.666
  speed: number;                     // 0 = paused; 0.25–8 typical
  start(): void;
  pause(): void;
  stepOnce(): Promise<void>;         // debug single-tick
}

// systems — domain logic lives here, outside runtime
interface System {
  readonly id: string;
  readonly everyNTicks: number;      // 1 = every tick
  readonly reads: BufferId[];        // declared access → scheduler orders + validates
  readonly writes: BufferId[];
  init(ctx: SystemContext): void | Promise<void>;
  update(ctx: SystemContext): void;  // sync inside a worker tick
}

interface Scheduler {
  register(system: System, placement: { workerGroup: string }): void;
  plan(): TickPlan;                  // deterministic ordering from reads/writes
}

// worker abstraction — Node first, others later
interface WorkerAdapter {
  spawn(entry: URL, data: WorkerBootData): WorkerHandle;
}
interface WorkerHandle {
  readonly port: MessagePort;
  postBatch(batch: CommandBatch, transfer?: ArrayBuffer[]): void;
  terminate(): Promise<number>;
  onError(cb: (err: Error) => void): void;
  onExit(cb: (code: number) => void): void;
}

interface WorkerPool {
  size: number;
  spawnAll(): Promise<void>;
  barrier(): Promise<void>;          // all workers reached tick boundary
  broadcast(batch: CommandBatch): void;
  shutdown(opts: { graceful: boolean; timeoutMs: number }): Promise<void>;
}

// memory
type BufferId = string & { __brand: "BufferId" };
interface MemoryLayout {
  defineShared(id: BufferId, spec: { type: TypedArrayCtor; length: number }): void;
  defineLocal(id: BufferId, spec: { type: TypedArrayCtor; length: number }): void;
  build(): MemoryHandles;            // SABs created once, views distributed at boot
}

// ownership — exclusive write ranges per worker
interface RegionMap {
  ownerOf(index: number, buffer: BufferId): WorkerId;
  writeRange(worker: WorkerId, buffer: BufferId): { start: number; end: number };
  ghostRanges(worker: WorkerId, buffer: BufferId): ReadonlyRange[]; // read-only neighbor borders
}

// messaging
interface CommandBuffer {
  push(cmd: SimCommand): void;
  flush(): CommandBatch;             // one postMessage per worker per tick, max
}

// rng — one stream per (system, region); never Math.random
interface RngStream {
  readonly streamId: string;
  nextU32(): number;
  nextF64(): number;                 // [0,1), derived from u32s for determinism
  fork(childId: string): RngStream;  // hash(seed, streamId, childId)
}

// events
interface EventQueue<E> {
  emit(e: E): void;                  // buffered; delivered at tick boundary
  drain(handler: (e: E) => void): void;
}

// snapshot / replay
interface SnapshotStore {
  capture(): Promise<Snapshot>;      // barrier → copy SAB ranges → resume
  restore(s: Snapshot): Promise<void>;
  schemaVersion: number;
  migrate(s: Snapshot, from: number): Snapshot;
}
interface ReplayLog {
  record(tick: bigint, batch: CommandBatch): void;
  playback(): AsyncIterable<[bigint, CommandBatch]>;
}

// profiling
interface Profiler {
  span(systemId: string, tick: bigint): () => void;  // start → stop
  report(): SystemTimings[];         // p50/p95/max, ring-buffered
}
```

Key design commitments:

- State is SoA typed arrays keyed by `BufferId`, not object graphs — required for SAB sharing and cache-friendly iteration (9).
- Systems declare `reads`/`writes`; scheduler derives deterministic order and rejects undeclared cross-region writes (8).
- Determinism strategy: fixed system order, fixed region iteration order, per-(system,region) RNG streams, deterministic reduction/merge order when combining worker results. Float summation order must be pinned wherever results feed back into state (9).

---

## 3. Phased Milestones

Each phase ships working, tested code. Acceptance criteria in §8.

**Phase 0 — Scaffolding (0.5 day)**
pnpm workspace, `tsc -b` project refs, Vitest, ESLint, CI script. Empty packages compile and test.

**Phase 1 — Single-threaded deterministic core (2–4 days)**
Clock (fixed timestep, pause, speed, stepOnce), scheduler with `everyNTicks`, RNG streams, event queues, profiler. Wa-Tor running single-threaded on typed arrays. State-hash function (FNV-1a over buffers).

**Phase 2 — Workers + transfer path (3–5 days)**
`WorkerAdapter` + Node impl, pool with spawn/barrier/terminate, command buffers, batched `MessagePort` messaging, transferred `ArrayBuffer` for bulk results (e.g., render extract). Wa-Tor regions run in N workers using message-passed border exchange (no SAB yet — validates protocol first) (7).

**Phase 3 — SharedArrayBuffer + ownership (3–5 days)**
`MemoryLayout` building SABs, `RegionMap` with exclusive write ranges + ghost reads, `Atomics.wait/notify` (or `Atomics.waitAsync` on main) tick barrier. Two-phase border resolution for cross-region migration: intent pass → deterministic conflict resolution (e.g., lower region index wins) → apply pass (8).

**Phase 4 — Snapshots, replay, versioning (2–3 days)**
Barrier-consistent capture/restore, command-log replay, `schemaVersion` + migration hook.

**Phase 5 — Errors + shutdown (1–2 days)**
Worker crash → pool policy: fail-fast (MVP) then restart-from-last-snapshot. Graceful shutdown with timeout, no orphaned workers, clean exit codes.

**Phase 6 — Profiling polish + benchmarks (1–2 days)**
Per-system p50/p95, ticks/sec harness, transfer-vs-SAB micro-benchmarks.

**Phase 7 — Extraction pass (1–2 days)**
Move anything Wa-Tor-specific out of `@sim/runtime`. Only now consider splitting packages. Write the "how to build a sim on this" doc as the extraction test: if the doc needs Wa-Tor knowledge, the boundary is wrong.

**Phase 8 — Express 5 layer (optional, 1–2 days)**
`apps/server`: start/pause/speed endpoints, SSE state stream from transferred snapshots. Zero imports from server into runtime internals.

Total: roughly 3–4 focused weeks for one developer with an agent (6 — schedule estimates are the least certain thing here).

---

## 4. Reference Simulation: Wa-Tor Predator-Prey

Toroidal grid, fish/shark/empty cells, energy + breed counters. Chosen because it is (8):

- Trivially SoA: `species: Uint8Array`, `energy: Int16Array`, `breedAge: Int16Array`.
- Grid-partitionable into worker regions with meaningful border traffic (movement, predation across borders) — exercises ownership, ghost cells, and conflict resolution, the actual hard problems.
- Fully deterministic given seed + rules; cheap enough to run 10⁵–10⁶ cells for benchmarks.
- Domain rules (movement, breeding, starvation) live entirely in `@sim/refsim`, proving the runtime/domain boundary.

Validation hooks: per-tick state hash; population counts as a coarse sanity metric.

---

## 5. Testing & Benchmarking

**Determinism suite (the core asset):** same seed + command log ⇒ identical state hash at tick N across (a) repeated runs, (b) worker counts 1/2/4/8, (c) save→load mid-run, (d) full replay from log. Run in CI at a fixed tick count (9 — this is the only reliable way to catch parallel nondeterminism).

**Unit (Vitest):** RNG stream reproducibility + fork independence, scheduler ordering from reads/writes, region map math, command buffer batching, snapshot round-trip, migration.

**Concurrency:** barrier under randomized worker delays (inject `setTimeout` jitter in test adapter), crash-during-tick recovery, shutdown timeout paths. A `TestWorkerAdapter` running "workers" in-process makes these fast and debuggable (7).

**Benchmarks:** tinybench for micro (RNG, hash, buffer ops); custom harness for macro: ticks/sec and p95 tick time at 256², 1024², 2048² grids × 1/2/4/8 workers; postMessage+transfer vs SAB for the border-exchange path. Record baselines as JSON in-repo; fail CI on >20% regression (6 — noise on shared CI runners may force a looser threshold or local-only benchmarking).

---

## 6. Risks & Mitigations

| Risk | Mitigation | Conf. |
|---|---|---|
| Parallel nondeterminism (float order, race in border resolution) | Two-phase intent/apply, pinned merge order, determinism CI suite across worker counts | 9 |
| SAB races / Atomics misuse | Exclusive write ranges enforced by `RegionMap`; `Atomics` only in barrier + a small set of audited counters; debug mode asserting writes stay in-range | 8 |
| Worker boot friction (TS + ESM entry) | Compile-first workflow from Phase 0; workers import built `.js` only | 8 |
| postMessage/structured-clone overhead dominating tick | Batch to ≤1 message per worker per tick; transfer, never clone, large buffers; benchmark in Phase 2 before SAB work | 8 |
| Barrier stalls / deadlock (`Atomics.wait` on main thread blocks event loop) | `Atomics.waitAsync` or port-message barrier on main; timeouts on every wait | 8 |
| Premature abstraction | Single runtime package; extraction only in Phase 7 against a written usage doc; WorkerAdapter is the *only* speculative interface, kept minimal | 8 |
| Snapshot torn state | Capture only at barrier; workers idle during copy; verify via restore→hash-equality test | 9 |
| GC pauses from per-tick allocation | Preallocate command/event buffers; object pooling only if profiler shows GC pressure — not preemptively | 7 |
| Schema drift breaking saves | Version int in header from Phase 4 day one; migration test fixtures per version bump | 8 |

---

## 7. MVP Boundaries

**In MVP (Phases 0–3):** deterministic single-thread core, worker pool + Node adapter, batched messaging + transfer, SAB + ownership, Wa-Tor at 1–8 workers, determinism suite.

**Explicitly out of MVP:** Express layer, replay tooling beyond raw log playback, worker auto-restart, non-Node adapters (browser/Deno — interface exists, unimplemented), dynamic region rebalancing, any rendering, multi-sim orchestration, package splitting.

Cut line rationale: everything in MVP is needed to *prove* the concurrency + determinism claims; everything out is additive (8).

---

## 8. Acceptance Criteria

| Phase | Criteria |
|---|---|
| 0 | `pnpm build && pnpm test` green from clean clone; CI runs both |
| 1 | Wa-Tor 10k ticks single-thread; identical hash across 3 runs; pause/speed/stepOnce covered by tests; profiler reports per-system p50/p95 |
| 2 | Same hash at 1 vs 2 vs 4 workers (message-passing borders); ≤1 postMessage per worker per tick verified by counter; transfer path zero-copy confirmed (`byteLength === 0` after transfer) |
| 3 | SAB path passes full determinism suite; debug-mode out-of-range write throws; SAB border exchange ≥ message-passing throughput at 1024² (if not, documented and message path stays default) (6) |
| 4 | Save at tick T → restore → tick 2T hash equals uninterrupted run; replay from log reproduces hash; v(n)→v(n+1) migration test passes |
| 5 | Injected worker crash → clean fail-fast with diagnostic (no hang, no orphan process); `shutdown()` resolves within timeout in all tests |
| 6 | Benchmark JSON baselines committed; CI regression check wired |
| 7 | `@sim/runtime` has zero Wa-Tor imports (lint rule); usage doc sufficient to start a second sim skeleton without reading refsim source |
| 8 | Server controls a running sim via public API only; killing server leaves sim process unaffected; runtime has zero Express imports |
