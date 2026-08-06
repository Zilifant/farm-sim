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
```

Note: workers (Phase 2+) run compiled `.js` from `dist/`, so `pnpm build`
must precede `pnpm test`.
