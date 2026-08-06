# wa-tor ASCII renderer

A browser-based ASCII grid renderer for the Wa-Tor reference simulation, in
the visual tradition of classic roguelike interfaces: a dark Dracula-themed
monospace character grid, one glyph per world cell, discrete cell updates,
and compact information-dense panels. It is a direct adaptation of the
[biome](https://github.com/Zilifant/biome) renderer — same stylesheet, same
layout, same conventions — cut down to that renderer's basic features.

**Like the Wa-Tor sim itself, this renderer is a demo/placeholder**: swap it
for another renderer, or keep it and build on it as part of a new sim
project. `docs/replacing-the-reference-sim.md` names every touchpoint.

> **Invariant, inherited from biome: the renderer portrays authoritative
> simulation output. It does not participate in simulation.** It never
> computes outcomes, never advances simulation time, and never mutates sim
> state — all external change is sent as protocol commands, and everything
> drawn comes from host frames and events.

## Running

```bash
pnpm build && pnpm serve     # then open http://localhost:3000
```

- **Grid**: fish `f` (cyan), sharks `S` (red), open water `~` (dim). Drag or
  arrows/WASD to pan (shift = fast), wheel or `+`/`-` to zoom (10–32px
  cells), `C` recenters.
- **Selection**: click any cell — grey fill plus corner brackets, and the
  Inspector shows its contents. Energy and breed age are a live query
  (`cell.inspect`), polled while the cell stays selected. `Esc` clears.
- **Controls**: pause/resume (`Space`), speed ladder (`[` / `]`), step
  +1/+10/+100/N (stepping pauses first, so it never fails on a running
  sim), and New World from seed — restart with a typed seed, a host-picked
  random one, or the current one replayed.
- **Status bar**: connection, LIVE badge, simulationId, run state, tick,
  populations, camera, zoom, and the last command's result (cleared the
  moment another command goes out).
- **Population**: counts plus sparkline trends, resampled by bucket mean so
  the whole history fits the column.
- **Events**: census readings with per-reading deltas.
- Panels fold on their `h2` (remembered in localStorage); column edges drag
  to resize.

## Architecture

Everything lives in `app/` as plain browser ES modules — no build step, no
dependencies; the host serves the directory statically.

```text
app/
  main.js                     entry: composition
  RendererApp.js              orchestration, rAF loop, input
  state/RendererStore.js      normalized authoritative-output store, validation
  rendering/
    Camera.js                 center + cell size, pan/zoom math (pure; from biome)
    GridProjection.js         world → cell → screen-pixel projection (pure; from biome)
    CellAppearance.js         ASCII glyph/color registry (pure) — reskin here
    AsciiGridRenderer.js      Canvas 2D drawing: water → creatures → overlays
  transports/
    RendererTransport.js      transport contract (from biome)
    WebSocketRendererTransport.js  live stream, backoff reconnect (from biome)
  ui/                         status bar, controls, inspector, legend,
                              population, event log, collapsible, columnResize
  styles/
    dracula.css               the Dracula Classic palette (single source of color)
    renderer.css              layout and panel styling (from biome)
```

The legend is **generated from `CellAppearance.js`**, so it cannot drift
from what the grid draws; to reskin the sim, edit that one registry.

## Protocol

The host (`apps/server/src/ws.ts`) speaks the biome envelope over `/ws`:

- server → client: `{ type: 'snapshot.full' | 'events.batch' |
  'command.result' | 'error', payload, requestId? }`
- client → server: `{ type: 'command', requestId, command }`

Full frames only — no deltas. Each frame carries the whole species grid
(base64) plus tick/run state/populations; the store replaces its world on
every frame, so a reconnect resynchronizes by construction. A change of
`simulationId` (a restart) drops selection, events, and history. Commands:
`simulation.pause/resume/setSpeed/step/restart`, `wator.spawn`,
`cell.inspect`.

The renderer imports **nothing** from `@sim/runtime` or `@sim/refsim` — it
speaks the protocol purely as message shapes over the transport
(`SUPPORTED_PROTOCOL_VERSION` in `state/RendererStore.js`).
