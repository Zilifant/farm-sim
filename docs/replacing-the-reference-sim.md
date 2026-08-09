# Replacing the reference simulation

Wa-Tor (`@sim/refsim`) is a demo/placeholder. Its job is to prove the
runtime works and to be a worked example of every pattern — it is meant to
be replaced by your simulation. This document is the mechanical recipe for
doing that, written so a person or an agent can follow it step by step.
`docs/building-a-sim.md` covers *how to design and build* a sim; this doc
covers *what to unplug where*.

Recommended order: build your sim **alongside** Wa-Tor first (steps 1–5),
and only delete `@sim/refsim` (steps 6–8) once your own determinism suite
is green. While it exists, Wa-Tor is your executable reference for the
message-passing border protocol, the SAB region, crash recovery, and the
test patterns.

## Where Wa-Tor lives — the complete map

| Path | What it is | Action when replacing |
|---|---|---|
| `packages/refsim/` | The whole reference sim: rules, regions, workers, drivers, tests, bench metrics, demo CLI | Ultimately delete (step 6); mine for patterns first |
| `apps/server/src/host.ts` (+ `main.ts`) | `SimHost` wraps the Wa-Tor sim behind HTTP | Repoint at your sim (step 4) |
| `apps/server/src/ws.ts` | The renderer's WebSocket protocol: full frames (species grid), census events, commands | Reshape the frame payload for your sim's state (step 4b) |
| `apps/server/renderer/` | The browser ASCII renderer (a demo/placeholder like the sim itself) | Reskin or replace (step 4b) |
| `apps/server/public/index.html` | The renderer's HTML shell: title, canvas id (`wator-canvas`), aria labels | Rename with the renderer (step 4b) |
| `apps/server/test/` | Server, WS-protocol, and renderer-unit tests, written against Wa-Tor semantics | Adjust expectations to your sim (step 4) |
| `apps/server/package.json`, `apps/server/tsconfig.json` | Depend on / reference `@sim/refsim` | Swap to your package (steps 4, 6) |
| `packages/refsim/src/bench/` | Benchmark CLI. `calibrate.ts`, `baseline.ts`, `main.ts` are generic; `metrics.ts` macro metrics are Wa-Tor | Move machinery into your package, rewrite macro metrics (step 5) |
| `bench/baselines.json` | Recorded Wa-Tor benchmark numbers | Re-record for your sim (step 5) |
| Root `package.json` scripts | `demo`, `bench*` point into refsim dist | Repoint (steps 5, 6) |
| Root `tsconfig.json` | Project reference to `packages/refsim` | Add yours (step 1), remove refsim (step 6) |
| `eslint.config.js` | Boundary rules name `@sim/refsim`/`wator` patterns | Add your package to the runtime restriction (step 2); drop refsim entries at deletion (step 6) |
| `README.md` | Describes Wa-Tor throughout | Rewrite for your sim (step 7) |
| `sim-runtime-plan.md`, `docs/*` | Historical plan and docs mentioning Wa-Tor | Leave (history) or prune to taste |

Generic infrastructure that needs **no** changes: everything in
`packages/runtime` (lint-enforced to contain zero Wa-Tor), the CI workflow,
`vitest.config.ts` and `pnpm-workspace.yaml` (both glob `packages/*` and
`apps/*`), and `apps/server/src/app.ts` (a thin adapter over the host).

## Step 1 — create your sim package

```sh
mkdir -p packages/mysim/src packages/mysim/test
```

`packages/mysim/package.json` (copy of refsim's shape, renamed):

```json
{
  "name": "@sim/mysim",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "dependencies": { "@sim/runtime": "workspace:*" },
  "devDependencies": { "@types/node": "^22.17.0", "typescript": "^5.9.2" }
}
```

`packages/mysim/tsconfig.json` — copy `packages/refsim/tsconfig.json`
verbatim (it already extends the base config and references the runtime).

Wire it in:

- Root `tsconfig.json`: add `{ "path": "packages/mysim" }` to `references`.
- `pnpm install` (registers the workspace link).

The workspace and vitest globs pick the package up automatically. Verify:
`pnpm build` compiles the empty package.

## Step 2 — guard the boundary immediately

In `eslint.config.js`, find the block scoped to `packages/runtime/**/*.ts`
and add your package to the restricted-import pattern group, e.g.
`"@sim/mysim", "@sim/mysim/*"`. The runtime must never import any domain
package; making the lint rule name yours keeps that true as you build.

## Step 3 — build the sim

Follow `docs/building-a-sim.md`. Two concrete starting points:

- Copy the skeleton from `packages/runtime/test/second-sim.test.ts` into
  `packages/mysim/src/index.ts` and reshape it — it is a complete minimal
  sim (buffers, systems, executor, hash, snapshot) with zero Wa-Tor content.
- For each capability you add, port the corresponding refsim test file as a
  template: `test/index.test.ts` (determinism/census), `parallel.test.ts`
  (worker-count hash equality, message counters), `shared.test.ts` (SAB),
  `snapshot.test.ts` (save/restore/replay/migration), `crash.test.ts`
  (fail-fast/recovery). Keep the assertions, swap the sim.

Definition of done for this step: your equivalents of the determinism
suite pass — identical hash across repeated runs, across 1/2/4 workers if
you go parallel, and save-at-T → restore → 2T equality.

## Step 4 — repoint the server (if you use it)

- `apps/server/package.json`: add `"@sim/mysim": "workspace:*"` to
  dependencies (leave refsim until step 6).
- `apps/server/tsconfig.json`: add a reference to
  `../../packages/mysim`.
- `apps/server/src/host.ts`: swap the `@sim/refsim` imports and the
  `createWaTorSim` call for your sim. `SimHost` needs your sim to expose:
  `tick`, `step()`, a status payload (rename `populations()` to whatever
  fits), `stateHash()`, `captureSnapshot()`/`restoreSnapshot()`, and
  optionally `spawn()` and an event queue. If your surface differs, adapt
  the host — `app.ts` only talks to the host and should not change.
- Update `apps/server/src/main.ts`'s seed handling if needed.

Verify: `pnpm build && pnpm exec vitest run apps/server` (adjust the
server tests' expectations to your sim's semantics).

### Step 4b — the renderer (if you use it)

The browser renderer (`apps/server/renderer/`, see its README) knows
Wa-Tor only through two seams:

- **The wire shape** — `apps/server/src/ws.ts` builds frames carrying the
  species grid and census events; reshape the payload for your sim's state
  and keep the envelope (`snapshot.full` / `events.batch` /
  `command.result`) so the transport, store scaffolding, and command flow
  port unchanged.
- **The appearance registry** — `renderer/app/rendering/CellAppearance.js`
  is the only place glyphs and colors exist; the legend and the metrics
  panel are generated from it. Reskinning a grid sim is mostly this one
  file plus the panel labels (StatusPanel, MetricsPanel, EventLog,
  InspectorPanel name fish and sharks).

`Camera.js`, `GridProjection.js`, both transports, `collapsible.js`,
`columnResize.js`, and the two stylesheets are sim-agnostic (they are
verbatim ports from the biome renderer) and carry over as-is. A non-grid
sim replaces the renderer wholesale — it is a placeholder, not a
framework component.

## Step 5 — move the benchmark harness

- Move `packages/refsim/src/bench/` to `packages/mysim/src/bench/` and fix
  imports. `calibrate.ts`, `baseline.ts`, and `main.ts` port unchanged —
  `main.ts` resolves `bench/baselines.json` relative to its compiled
  location (`dist/bench/`), which is the same depth in your package.
- Add `"tinybench": "^6.1.2"` to your package's dependencies (and remove
  it from refsim's later).
- Rewrite `metrics.ts`: keep the micro metrics (they benchmark runtime
  primitives) and replace the macro metrics with your sim's modes/sizes.
- Root `package.json`: repoint the `bench`, `bench:record`, `bench:check`
  scripts at `packages/mysim/dist/bench/main.js`.
- Re-record: `pnpm build && pnpm bench:record -- --full`. Commit the new
  `bench/baselines.json`; `pnpm bench:check` and the CI step now gate your
  sim's performance.

## Step 6 — delete Wa-Tor

Only after your own suite is green:

```sh
git rm -r packages/refsim
```

Then remove every remaining reference:

- Root `tsconfig.json`: drop the `packages/refsim` reference.
- Root `package.json`: repoint or drop the `demo` script
  (`packages/refsim/dist/main.js`).
- `apps/server/package.json`: drop the `@sim/refsim` dependency;
  `apps/server/tsconfig.json`: drop its reference.
- `eslint.config.js`: in the runtime boundary block, the
  `@sim/refsim`/`wator` pattern entries can go (yours from step 2 stays);
  delete the `packages/refsim/**` express-restriction block.
- `apps/server`: any Wa-Tor names steps 4/4b left behind — the
  `wator.spawn` command and `wator-` simulationId prefix in `src/ws.ts`,
  the `wator-canvas` id in `public/index.html` and `renderer.css`, and the
  renderer's `README-RENDERER.md` prose.
- `docs/building-a-sim.md`: remove or reword the final paragraph pointing
  at refsim.
- `pnpm install` to refresh the lockfile.

## Step 7 — rewrite the Wa-Tor prose

`README.md` describes Wa-Tor's modes, demo, and benchmark numbers —
rewrite those sections for your sim. `sim-runtime-plan.md` is the original
build plan; keep it as history or delete it.

## Step 8 — verify the extraction

```sh
git grep -il -e wator -e refsim -e wa-tor -- ':!pnpm-lock.yaml'
```

Expected survivors: this file, and (if kept) `sim-runtime-plan.md` /
historical docs. Nothing under `packages/`, `apps/`, or config files.
Then the full gate:

```sh
pnpm install && pnpm check && pnpm bench:check
```

All green means the placeholder is fully out and the repo is yours.
Wa-Tor remains available in git history whenever you need the worked
example back.
