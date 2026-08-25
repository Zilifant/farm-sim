# Building a simulation on `@sim/runtime`

This document is the runtime's boundary test: it must be enough to start a
new simulation without reading any reference-sim source. Everything below
imports only from `@sim/runtime`. The skeleton in §3 is kept compiling and
passing as `packages/runtime/test/second-sim.test.ts`.

## 1. The model

A simulation is:

- **State** — structure-of-arrays typed arrays keyed by branded `BufferId`s
  (never object graphs). This is what makes state hashable, snapshotable,
  and shareable across threads.
- **Systems** — your domain logic. Each `System` declares an `id`, a cadence
  (`everyNTicks`), and the buffers it `reads`/`writes`. The runtime validates
  declarations and rejects undeclared buffer access at runtime.
- **Ticks** — a `TickExecutor` runs the systems of a `TickPlan` in
  deterministic order, handing each a validated `SystemContext` (tick,
  buffer access, a forked RNG stream).

Nothing about your domain lives in the runtime; the runtime never imports
your package.

## 2. Determinism rules

The runtime's core promise is: same seed (+ same command log) ⇒ identical
state hash, across runs, machines, and worker counts. To keep that promise:

1. **Never call `Math.random()`.** Use `Sfc32Stream` (sequential, forkable)
   or the counter hashes (`hashCell`, `hashU32`).
2. **Pick the right randomness kind.** A *stream*'s value depends on how
   many draws preceded it — fine for one-shot setup, wrong for anything that
   must be partition-invariant. For per-entity/per-cell decisions inside a
   tick, use `hashCell(seedHash, tickLo, tickHi, entityIndex, salt)` (split
   the tick with `splitTick`); the result depends only on those inputs, so
   iteration order and region partitioning cannot change outcomes.
3. **Pin every ordering that feeds state**: system order (registration
   order), entity iteration order, merge order when combining results.
   Float summation order counts.
4. **Hash everything, always.** `hashBuffers([...views])` (chained FNV-1a)
   is cheap; assert hash equality in tests across run counts, worker counts,
   and save/restore.

## 3. A minimal single-threaded sim

Walkers on a ring, depositing heat; a gauge system reports totals every 5
ticks. This exact code runs as the runtime's second-sim boundary test.

```ts
import {
  BufferRegistry, Sfc32Stream, SimEventQueue, SystemScheduler, TickExecutor,
  bufferId, hashBuffers, hashCell, seedToU32, splitTick,
  type System, type SystemContext,
} from "@sim/runtime";

const POS = bufferId("drift.pos");
const HEAT = bufferId("drift.heat");

interface DriftConfig { ring: number; walkers: number; seed: string }

class WalkSystem implements System {
  readonly id = "drift.walk";
  readonly everyNTicks = 1;
  readonly reads = [POS, HEAT];
  readonly writes = [POS, HEAT];
  #pos!: Int32Array; #heat!: Int32Array;
  readonly #seedHash: number;
  constructor(readonly cfg: DriftConfig) { this.#seedHash = seedToU32(cfg.seed); }

  init(ctx: SystemContext): void {
    this.#pos = ctx.buffer<Int32Array>(POS);
    this.#heat = ctx.buffer<Int32Array>(HEAT);
    const rng = ctx.rng.fork("init");         // stream: fine for setup
    for (let i = 0; i < this.#pos.length; i++) this.#pos[i] = rng.nextU32() % this.cfg.ring;
  }

  update(ctx: SystemContext): void {
    const { lo, hi } = splitTick(ctx.tick);
    for (let i = 0; i < this.#pos.length; i++) {
      const step = (hashCell(this.#seedHash, lo, hi, i, 1) & 1) === 0 ? -1 : 1;
      const next = (this.#pos[i]! + step + this.cfg.ring) % this.cfg.ring;
      this.#pos[i] = next;
      this.#heat[next]!++;
    }
  }
}

const cfg: DriftConfig = { ring: 64, walkers: 10, seed: "demo" };
const buffers = new BufferRegistry();
buffers.define(POS, { type: Int32Array, length: cfg.walkers });
buffers.define(HEAT, { type: Int32Array, length: cfg.ring });

const scheduler = new SystemScheduler(buffers);
scheduler.register(new WalkSystem(cfg));
// scheduler.register(gaugeSystem)           // everyNTicks: 5, emits events

const executor = new TickExecutor({
  plan: scheduler.plan(),
  buffers,
  rng: Sfc32Stream.create(cfg.seed, "drift"),
  fixedDtMs: 1000 / 60,
});
await executor.init();

let tick = 0n;
for (let i = 0; i < 500; i++) executor.runTick(tick++);
console.log(hashBuffers([buffers.get(POS), buffers.get(HEAT)]).toString(16));
```

Supporting pieces, all optional:

- **Events**: `SimEventQueue<E>` — systems `emit()` during a tick, your
  driver `drain()`s at tick boundaries; emits during a drain defer to the
  next drain.
- **Profiling**: pass a `RingProfiler` to the executor; `report()` gives
  ring-buffered p50/p95/max/mean per system. `quantile()` is exported for
  your own timing data.
- **Real-time pacing**: `FixedStepClock` drives `onTick` with a fixed
  timestep, accumulator, `speed` (0 = idle), `pause()`, `stepOnce()`, and a
  catch-up cap. Wall time never affects results — only when ticks happen.
  Inject `now`/`setTimer` in tests to drive it with virtual time.

## 4. Snapshots, migration, replay

A `Snapshot` is `{ schemaVersion, tick, meta, buffers }` — raw byte copies
via `snapshotBuffer(view)`, restored with `restoreInto(view, buf)` (or
materialized with `viewFromSnapshotBuffer`). Because randomness is
counter-based, there is no RNG state to save: buffers + tick + config fully
determine the future. Capture only at a tick boundary; put your config in
`meta` and refuse to restore on mismatch.

- Serialize with `encodeSnapshot`/`decodeSnapshot` — the schema version
  lives in the binary header.
- Version from day one: create a `SnapshotMigrator(currentVersion)` and
  `register(fromVersion, step)` one migration per bump; `migrate()` chains
  them and rejects newer-than-current snapshots.
- External inputs (user commands) go through an `InMemoryReplayLog`:
  `record(tick, batch)` when a command is applied, and replay by running to
  each entry's tick and re-applying. `(seed, config, log)` reproduces a run.

Test to write immediately: save at tick T → restore → run to 2T → hash
equals an uninterrupted 2T run.

## 5. Going parallel: message-passing workers

Partition state into regions (for grids: row strips), one worker per
region, ghost copies of neighbor borders, one exchange per tick.

- **Worker side**: export a `setup(port, boot)` function that builds your
  region from `boot` and calls `serveWorker(port, { handlers })`. Handlers
  are keyed by command `kind`; each incoming batch gets exactly one reply
  (`ctx.reply(cmd)`, bulk arrays via `ctx.transfer(...buffers)` — the
  runtime asserts transfers actually detached, i.e. moved not copied). A
  thin entry file reads `workerData` and calls setup; entries must be
  compiled `.js` (build first — workers do not run TS).
- **Main side**: `DefaultWorkerPool({ adapter, entry, size, boot })`, then
  `exchange((i) => ({ batch, transfer }))` once per tick: send each worker
  its neighbors' border data from last tick, get its new borders back.
  Awaiting `exchange` *is* the tick barrier. Keep it to one message per
  worker per tick in each direction.
- **Adapters**: `NodeWorkerAdapter` spawns real `worker_threads` (it does
  not inherit `execArgv`, so test-runner flags can't break worker boot).
  `TestWorkerAdapter((port, boot) => setup(port, boot))` runs the identical
  protocol in-process for fast, debuggable tests.
- **Determinism across worker counts** requires a partition-invariant rule:
  counter-hash randomness plus per-tick write sets that are disjoint by
  construction (e.g. schedule entities so no two acting entities share a
  neighborhood — a distance coloring; run one color class per tick).
  Verify with the hash suite at 1/2/4 workers.

## 6. Shared memory: SAB + Atomics

The high-throughput path — no border copies, no per-tick messages:

- `SharedMemoryLayout`: `defineShared(id, { type, length })`, `build()`
  once on main. Ship `handles.manifest()` to workers in boot data (SABs
  share by structured clone) and rebuild views with
  `attachSharedViews(manifest)`.
- `RowRegionMap({ width, height, strips })`: exclusive `writeRange` per
  worker, toroidal `ghostRanges` (readable neighbor borders), `spillRanges`
  (the adjacent rows migration writes may land in), and merged
  `writableRanges` to feed a `WriteGuard`. In debug builds, call
  `guard.assert(idx)` on every write (or wrap a view with `guardView`) —
  out-of-range writes throw instead of corrupting a neighbor.
- `AtomicsBarrier.allocate(parties)`: workers call `arrive()` after each
  tick; every wait has a timeout so a lost worker is an error, not a
  deadlock. The main thread must never be a party — it synchronizes by
  awaiting a pool exchange per *batch* of ticks, and reads state directly
  from the SABs while workers idle between batches.
- Have each worker seed its own rows at boot, then run one `pool.barrier()`
  before the first batch so nobody reads unseeded neighbor rows.

The same conflict-free-write-set requirement from §5 applies — with it,
concurrent tick execution needs no locks and no intent/resolve/apply pass.

## 7. Crashes and shutdown

The pool fails fast: one worker error or unexpected exit rejects all
in-flight replies with a diagnostic, terminates the survivors (including
ones blocked in the barrier), and poisons the pool. `shutdown({ graceful,
timeoutMs })` always resolves and reports every exit code; graceful asks
workers to close (exit 0) and terminates stragglers on timeout.

For resilience, layer restart-from-snapshot on top: keep a periodic
snapshot; on `onFailure` (or a rejected exchange), force-shutdown the dead
pool, respawn workers with a **fresh** barrier, restore the snapshot, and
re-simulate the lost ticks — determinism makes the recovery exact. Bound it
with a restart budget. For tests, `pool.crash` (real threads) and
`TestWorkerHandle.simulateCrash()` inject failures.

## 8. Package layout

Keep your domain in its own package that depends on `@sim/runtime`; the
runtime never imports domain code (enforced here by a lint rule). The
runtime deliberately stays a single package — split it only when a second
real simulation forces a boundary, not before.

Suggested test list for any new sim: hash-identical repeated runs;
divergence across seeds; hash-identical across 1/2/4 workers; save at T →
restore → 2T equality; replay-log reproduction; crash → fail-fast/recovery.

For a worked example of a complete sim on this runtime, see `@sim/farm` —
but nothing above requires it. The Wa-Tor reference sim that originally
accompanied this document (toroidal grid, border exchange, all three
execution modes) lives in git history; `docs/replacing-the-reference-sim.md`
records how it was replaced.
