# simulation-engine

TypeScript simulation runtime built inside a Wa-Tor predator-prey reference
simulation. See [sim-runtime-plan.md](./sim-runtime-plan.md) for the full plan.

## Packages

- `packages/runtime` — `@sim/runtime`: reusable simulation infrastructure
  (clock, scheduler, workers, memory, messaging, rng, events, snapshot, profile).
- `packages/refsim` — `@sim/refsim`: Wa-Tor predator-prey reference simulation.
- `apps/server` — `@sim/server`: Express 5 control API over a hosted sim
  (start/pause/speed/step, spawn, binary snapshot download/restore, SSE
  state stream), plus a **browser ASCII renderer** served at `/` with a
  WebSocket frame/command stream at `/ws`. Run with `pnpm serve` (after
  build), then open http://localhost:3000 — the REST endpoint list is at
  `GET /api`. The renderer (`apps/server/renderer/`, see its
  [README](./apps/server/renderer/README-RENDERER.md)) is a Dracula-themed
  roguelike-style grid adapted from the biome renderer, and like the Wa-Tor
  sim it is a demo/placeholder to swap or build on. The HTTP layer only
  holds a reference to the sim host — closing the server leaves the
  simulation ticking, and lint rules keep Express out of the sim packages
  and internals out of the server.

Wa-Tor is a demo/placeholder: it proves the runtime works and serves as the
worked example of every pattern, and it is meant to be replaced by your
simulation. The runtime has zero Wa-Tor imports — enforced by a lint rule
and proven by `packages/runtime/test/second-sim.test.ts`, a complete second
sim built from runtime APIs alone.

**To build your own sim**: start with
[docs/building-a-sim.md](./docs/building-a-sim.md) (how to design and build
on the runtime — written to be sufficient without reading refsim source),
then follow [docs/replacing-the-reference-sim.md](./docs/replacing-the-reference-sim.md)
(the step-by-step recipe for swapping Wa-Tor out: every touchpoint, in
order, with verification commands). The runtime stays a single package
until a second real simulation forces a split.

## Development

Requires Node >= 22 and pnpm 10.

```sh
pnpm install
pnpm build   # tsc -b project references
pnpm test    # vitest
pnpm lint    # eslint
pnpm check   # build + lint + test (what CI runs)
pnpm demo    # run Wa-Tor for 1000 ticks and print census + timings (after build)
```

`pnpm demo [seed] [ticks] [workers]` — with `workers >= 1` the grid is
partitioned into row strips across real worker threads with message-passed
border exchange; the state hash is identical for any worker count.

## Execution modes

Wa-Tor runs identically (same seed ⇒ same state hash) in three modes:

1. **Sequential** — one region spanning the grid.
2. **Message-passing workers** — row strips with ghost rows; borders
   exchanged through the main thread once per tick, zero-copy transfers.
3. **SAB + Atomics** (`createSharedWaTorSim`) — state in SharedArrayBuffers,
   workers own exclusive row ranges (`RowRegionMap`) and synchronize ticks
   with an `Atomics.wait/notify` barrier; main exchanges one message per
   *batch* of ticks and never blocks on Atomics. `debug: true` enforces
   per-worker write ranges on every store.

The color-phase update rule (see `packages/refsim/src/region.ts`) makes each
tick's write set conflict-free by construction, so the SAB path needs no
intent/resolve/apply pass for cross-region migration.

## Snapshots & replay

All modes capture barrier-consistent snapshots (`captureSnapshot`) and
restore them (`restoreSnapshot`) — snapshots are portable across modes, and
`encodeSnapshot`/`decodeSnapshot` give a binary format with the schema
version in the header. Old saves migrate through `watorMigrator` (v1→v2
pins `sharkMaxEnergy` to the Int16 ceiling, preserving the old
unbounded-banking semantics). Because the RNG is counter-based, a snapshot
is just (buffers, tick, config) — no generator state.

External `spawn` commands recorded to a `ReplayLog` replay exactly:
(seed, config, log) reproduces a run's state hash in the sequential and SAB
modes.

## Crash handling

The worker pool fails fast: one worker error or unexpected exit rejects all
in-flight work with a diagnostic, terminates the surviving workers (no
orphans — a worker blocked in the tick barrier is cut short, not waited
out), and poisons the pool. `shutdown()` always resolves within its timeout
and reports every worker's exit code. The SAB driver can additionally opt
into `recovery: { snapshotEveryTicks }` — on a crash it respawns a fresh
pool and barrier, restores the last snapshot, and deterministically
re-simulates the lost ticks (`stats().restarts` counts these). Crash
injection for tests: `sim.injectCrash(worker, exitCode)` /
`TestWorkerHandle.simulateCrash()`.

Throughput (`node packages/refsim/dist/bench.js 1020 100 4`, this container,
Phase 3 acceptance — 1020 stands in for 1024, grid dims must be multiples
of 5): sequential 56 ticks/sec, message-passing ×4 126 ticks/sec,
SAB+Atomics ×4 191 ticks/sec.

## Benchmarks

```sh
pnpm bench            # quick set: tinybench micro (rng/hash/buffer) + macro
pnpm bench -- --full  # adds the 1020²/2040² × 1/2/4/8-worker matrix
pnpm bench:record     # rewrite bench/baselines.json (accept new numbers)
pnpm bench:check      # re-measure quick set, fail on >20% regression
```

Baselines live in `bench/baselines.json` with raw values, machine info, and
calibration-normalized figures (a fixed fnv1a32 workload timed at startup
partially cancels machine-speed differences). CI runs `bench:check` with a
loose ±50% tolerance (`BENCH_TOLERANCE`) since GitHub runners differ from
the baseline machine and are noisy; run locally at the default ±20% for a
strict comparison, and `bench:record` after intentional performance
changes. Macro metrics report ticks/sec plus a p95 tick time (sequential:
update-system span; message mode: main-thread exchange round trip; SAB:
per-tick compute inside workers, max across workers, barrier wait
excluded).

Note: workers (Phase 2+) run compiled `.js` from `dist/`, so `pnpm build`
must precede `pnpm test`.
