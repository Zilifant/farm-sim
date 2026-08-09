# CLAUDE.md

A deterministic, multithreaded TypeScript simulation runtime
(`@sim/runtime`), proven by a Wa-Tor reference sim (`@sim/refsim`) and an
Express + WebSocket host with a browser ASCII renderer (`@sim/server`).
**The Wa-Tor sim and its renderer are demo/placeholders** — this repo is a
framework meant to be duplicated and built on.

## Commands

```sh
pnpm install
pnpm build          # tsc -b project references — REQUIRED before test/demo/serve
pnpm test           # vitest; tests import built dist/, so build first
pnpm lint           # eslint (also enforces architecture boundaries, see below)
pnpm check          # build + lint + test (what CI runs)
pnpm demo [seed] [ticks] [workers]   # Wa-Tor CLI demo
pnpm serve          # sim + renderer at http://localhost:3000 (REST list: GET /api)
pnpm bench          # quick benchmark set; -- --full for the large-grid matrix
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
- `packages/refsim` — Wa-Tor: `rules.ts` (cell rules shared by all modes),
  `region.ts` (strip + ghost rows), `wator-shared.ts` (SAB mode),
  `parallel*.ts` (drivers), `bench/` (benchmark CLI — machinery generic,
  metrics Wa-Tor).
- `apps/server` — `src/` TS host (SimHost owns sim + clock; app.ts REST;
  ws.ts renderer protocol); `renderer/` plain browser ES modules (no build
  step, adapted from the biome renderer); `public/index.html`.

Wa-Tor runs in three modes (sequential / message-passing workers /
SAB+Atomics) that produce **identical state hashes** — the cross-mode
equality tests are the repo's core asset. This works because the update
rule is conflict-free by construction (5-coloring, counter-hash RNG), which
is also why grid dims must be multiples of 5.

## Invariants (lint-enforced where possible)

- `@sim/runtime` imports no domain code (no refsim/wator) and no express.
- `apps/server` imports only public package entry points.
- The renderer imports nothing from any package — it speaks the WS
  protocol as message shapes only.
- Never `Math.random()` in sim code: seeded `Sfc32Stream` for setup,
  `hashCell(seed, tick, cell, salt)` for anything partition-invariant.
- Snapshots capture only at tick/batch boundaries; they carry a schema
  version (`watorMigrator` migrates old saves).
- Closing the HTTP server must leave the sim ticking (host owns the sim,
  server holds a reference).

## Docs

- `docs/building-a-sim.md` — how to build a sim on the runtime (its
  skeleton is kept passing as `packages/runtime/test/second-sim.test.ts`).
- `docs/replacing-the-reference-sim.md` — the step-by-step recipe for
  swapping Wa-Tor (and its renderer) out; keep its touchpoint map in sync
  when adding Wa-Tor-coupled code.
- `apps/server/renderer/README-RENDERER.md` — renderer operation and seams.
- `sim-runtime-plan.md` — the original plan, complete and retired;
  provenance only.

## Gotchas

- Benchmark numbers in docs are historical single-machine readings;
  re-measure, don't inherit. CI runs `bench:check` at a loose ±50%
  (`BENCH_TOLERANCE`) because runners differ from the baseline machine.
- `NodeWorkerAdapter` deliberately does not inherit `execArgv` — test
  runners' flags break worker boot otherwise.
- Multi-worker strips need ≥2 rows (message mode's ghost reconstruction);
  `partitionRows` enforces it.
- In-process `TestWorkerAdapter` must never receive `pool.crash` (it would
  exit the host process); use `TestWorkerHandle.simulateCrash()`.
