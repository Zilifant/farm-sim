# farm-sim

A farm-management simulation game built on a deterministic TypeScript
simulation runtime, rendered in the browser as a roguelike-style ASCII map.
The player runs the farm as a business and biological system: choosing what
to grow, scheduling operations against machinery/labor/weather constraints,
reacting to drought and frost, timing sales against moving markets, and
reinvesting in land and equipment across multiple simulated years.

## Packages

- `packages/runtime` — `@sim/runtime`: reusable simulation infrastructure
  (clock, scheduler, workers, memory, messaging, rng, events, snapshot,
  profile). Domain-free; see `docs/building-a-sim.md`.
- `packages/farm` — `@sim/farm`: the farm simulation. One tick is one day.
  The player starts with a homestead on one parcel and places fields freely
  on owned ground (any rectangle, anywhere the seeded soil-quality map
  makes attractive); neighboring parcels are purchasable. Fields carry soil
  quality, moisture, fertility, and rotation memory; counter-hash weather
  with a decaying-confidence forecast, six crops with planting windows and
  condition-driven yields, a capacity-constrained operation queue,
  commodity markets, storage, finances with daily interest and an
  asset-capped credit line, and year-end summaries. Deterministic:
  (seed, config, command log) reproduces a run exactly.
- `apps/server` — `@sim/server`: Express 5 control API over the hosted farm
  (start/pause/speed/step, farm commands, binary snapshot download/restore,
  SSE state stream), plus the **browser ASCII renderer** served at `/` with
  a WebSocket frame/command stream at `/ws`.

## Running

```sh
pnpm install
pnpm build          # required before test/serve — workers and tests run dist/
pnpm serve          # farm + renderer at http://localhost:3000
pnpm check          # build + lint + test
```

Open http://localhost:3000: the map shows your homestead and the land
around it. Press `F` (or the Farm Office button) and drag a rectangle on
your ground to place a field of any size; click a field for its floating
window (plant, fertilize, irrigate, harvest, plow under); click `$` ground
to buy the parcel. The Farm Office panel sells from storage, manages the
loan and crew, and upgrades machinery; the Markets panel tracks prices;
the event log records operations, harvests, weather damage, and year-end
closes. Speed runs from 0.25× to 32× (one simulated day per second at 1×).

## The simulation

Everything is a pure function of `(seed, config, command log)`:

- Weather is a counter hash of `(seed, day)` — no stored RNG state, and the
  in-game forecast literally computes the future, then blurs it with
  lead-time uncertainty.
- Yields emerge from conditions over the season, not a die roll:
  `base × soil quality × planting date × moisture stress × season-average
  fertility × frost damage × harvest timing`.
- Operations compete daily for machine capacity (acres/day per implement),
  a shared labor pool, and workable weather, in queue order.
- Prices follow mean-reverting seasonal walks, clamped to plausible bands.

State lives entirely in typed-array buffers, so the whole farm is hashable
(`stateHash()`), snapshotable (binary download/restore over HTTP), and
replayable. The determinism suite (`packages/farm/test`) pins repeated-run
and save/restore/replay equality.

## Docs

- `docs/building-a-sim.md` — how to build a sim on `@sim/runtime`.
- `docs/replacing-the-reference-sim.md` — the recipe this project followed
  to replace the runtime's original reference sim (retired history).
- `apps/server/renderer/README-RENDERER.md` — renderer operation and seams.
