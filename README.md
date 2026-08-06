# simulation-engine

TypeScript simulation runtime built inside a Wa-Tor predator-prey reference
simulation. See [sim-runtime-plan.md](./sim-runtime-plan.md) for the full plan.

## Packages

- `packages/runtime` — `@sim/runtime`: reusable simulation infrastructure
  (clock, scheduler, workers, memory, messaging, rng, events, snapshot, profile).
- `packages/refsim` — `@sim/refsim`: Wa-Tor predator-prey reference simulation.

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

Throughput (`node packages/refsim/dist/bench.js 1020 100 4`, this container,
Phase 3 acceptance — 1020 stands in for 1024, grid dims must be multiples
of 5): sequential 56 ticks/sec, message-passing ×4 126 ticks/sec,
SAB+Atomics ×4 191 ticks/sec.

Note: workers (Phase 2+) run compiled `.js` from `dist/`, so `pnpm build`
must precede `pnpm test`.
