# CLAUDE.md

A farm-management simulation (`@sim/farm`) on a deterministic,
multithreaded TypeScript simulation runtime (`@sim/runtime`), hosted by an
Express + WebSocket server with a browser ASCII renderer (`@sim/server`).
The Wa-Tor reference sim (`@sim/refsim`) remains in-repo as the runtime's
worked example of the parallel execution modes and as the benchmark
subject — the hosted app and renderer are the farm's.

## Commands

```sh
pnpm install
pnpm build          # tsc -b project references — REQUIRED before test/demo/serve
pnpm test           # vitest; tests import built dist/, so build first
pnpm lint           # eslint (also enforces architecture boundaries, see below)
pnpm check          # build + lint + test (what CI runs)
pnpm demo [seed] [ticks] [workers]   # Wa-Tor CLI demo (refsim)
pnpm serve          # farm + renderer at http://localhost:3000 (REST list: GET /api)
pnpm bench          # refsim benchmark set; -- --full for the large-grid matrix
pnpm bench:check    # compare against bench/baselines.json (±20% default)
pnpm bench:record   # rewrite baselines after intentional perf changes
```

Build-first is load-bearing twice over: workers run compiled `.js` from
`dist/` (never TS), and tests resolve packages through their `exports`
maps into `dist/`.

## Architecture

- `packages/runtime` — all reusable infra: `clock/` (fixed-timestep),
  `schedule/` (systems + deterministic executor), `workers/` (adapter,
  pool, serve loop, Atomics barrier), `memory/` (SoA buffer registry, SAB
  layout, region ownership, write guard, FNV-1a hash), `messaging/`
  (command batches, zero-copy transfer), `rng/` (seeded streams + counter
  hashes), `snapshot/` (binary codec, migrator, replay log), `profile/`.
- `packages/farm` — the farm sim, one tick = one day: `catalog.ts` (crops,
  equipment, economy constants — balance lives here), `layout.ts` (the
  fixed field map + renderer cell codes), `state.ts` (every state buffer +
  config; `STATE_BUFFERS` order is part of the snapshot/hash schema),
  `weather.ts` (pure counter-hash weather + forecast), `systems.ts`
  (weather → soil → operations → growth → market → finance → year end),
  `commands.ts` (the player surface), `snapshot.ts` (schema v1 +
  `farmMigrator`), `index.ts` (`createFarmSim` + read views).
- `packages/refsim` — Wa-Tor: `rules.ts`, `region.ts`, `wator-shared.ts`
  (SAB mode), `parallel*.ts` (drivers), `bench/` (benchmark CLI).
- `apps/server` — `src/` TS host (SimHost owns sim + clock; app.ts REST;
  ws.ts renderer protocol v2 — full frames carry the map as appearance
  codes plus structured farm state); `renderer/` plain browser ES modules
  (no build step); `public/index.html`.

The farm runs single-threaded — nine fields do not need workers — but keeps
the runtime's determinism contract: identical state hash across repeated
runs, save/restore, and command-log replay (`packages/farm/test`).

## Invariants (lint-enforced where possible)

- `@sim/runtime` imports no domain code (no farm, no refsim/wator) and no
  express.
- `apps/server` imports only public package entry points.
- The renderer imports nothing from any package — it speaks the WS
  protocol as message shapes only, and restates protocol constants
  (cell codes, command kinds) as data.
- Never `Math.random()` in sim code: seeded `Sfc32Stream` for setup,
  `hashCell(seed, tick, cell, salt)` for anything partition-invariant.
  Farm weather/markets/forecasts are pure counter-hash functions of
  (seed, day) — no stored RNG state.
- Player commands go through `FarmSim.apply()` at a tick boundary and are
  recorded to the replay log; (seed, config, command log) reproduces a run.
- Snapshots capture only at tick/batch boundaries; they carry a schema
  version (`farmMigrator` / `watorMigrator` migrate old saves).
- Closing the HTTP server must leave the sim ticking (host owns the sim,
  server holds a reference).

## Docs

- `docs/building-a-sim.md` — how to build a sim on the runtime (its
  skeleton is kept passing as `packages/runtime/test/second-sim.test.ts`).
- `docs/replacing-the-reference-sim.md` — the recipe the farm followed;
  also the map of what remains of Wa-Tor if it is ever deleted (step 6+).
- `apps/server/renderer/README-RENDERER.md` — renderer operation and seams.
- `sim-runtime-plan.md` — the runtime's original build plan, complete and
  retired; provenance only.

## Gotchas

- Balance numbers (crop yields, the soil water balance, climate) interlock:
  the smoke check is a scripted year — plant the six owned fields in
  spring, harvest in fall — which should complete all plantings in-window
  and land corn near 90–130 bu/ac. `packages/farm/test/farm.test.ts` pins
  the qualitative dynamics (late planting loses, fertilizer pays, rotation
  matters); re-tune against those.
- Benchmark numbers in docs are historical single-machine readings;
  re-measure, don't inherit. CI runs `bench:check` at a loose ±50%
  (`BENCH_TOLERANCE`) because runners differ from the baseline machine.
- `NodeWorkerAdapter` deliberately does not inherit `execArgv` — test
  runners' flags break worker boot otherwise.
- Multi-worker strips need ≥2 rows (message mode's ghost reconstruction);
  `partitionRows` enforces it (refsim only — the farm is single-threaded).
- In-process `TestWorkerAdapter` must never receive `pool.crash` (it would
  exit the host process); use `TestWorkerHandle.simulateCrash()`.
