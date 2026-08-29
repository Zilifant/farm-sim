# farm-sim ASCII renderer

A browser-based ASCII map renderer for the farm simulation, in the visual
tradition of classic roguelike interfaces: a dark Dracula-themed monospace
character grid, one glyph per map cell, discrete cell updates, and compact
information-dense panels. It is a direct adaptation of the
[biome](https://github.com/Zilifant/biome) renderer — same stylesheet, same
layout, same conventions — extended with the farm's management panels.

> **Invariant, inherited from biome: the renderer portrays authoritative
> simulation output. It does not participate in simulation.** It never
> computes outcomes, never advances simulation time, and never mutates sim
> state — all external change is sent as protocol commands, and everything
> drawn comes from host frames and events.

## Running

```bash
pnpm build && pnpm serve     # then open http://localhost:3000
```

- **Map**: fields as blocks of crop glyphs — shape tracks growth (`.` planted,
  `,` germinating, lowercase growing, UPPERCASE mature) and color tracks the
  crop; `~` fallow field, `.` grass lanes, `#` farmstead, dim `$` parcels for
  sale. Drag or arrows/WASD to pan (shift = fast), wheel or `+`/`-` to zoom,
  `C` recenters. Hovering a cell washes its whole field, so the management
  unit reads at once.
- **Field window**: click a field and a floating window opens beside the
  click — the field's crop, stage, progress, expected yield, and condition
  gauges, plus every action that applies to it: plant (a crop picker with
  live prices), fertilize, irrigate, harvest, cancel its queued work, or
  buy the parcel if it is for sale. Drag it by its header; `Esc` or ×
  closes. The map is the way in to all per-field play.
- **Controls**: pause/resume (`Space`), speed ladder 0.25×–32× (`[` / `]`),
  step +1/+10/+100/N days (stepping pauses first), and New Farm from seed.
- **Farm Office**: the farm-wide surface — the work queue's overview with
  cancel buttons; sell from storage; borrow/repay and size the crew;
  machinery upgrades. Per-field actions live in the field window.
- **Status bar**: connection, LIVE badge, simulationId, run state, calendar
  date, season, today's weather, cash, debt, camera, zoom, and the last
  command's result (cleared the moment another command goes out).
- **Markets**: per-crop price with change vs. the long-term average and a
  price-history sparkline (resampled by bucket mean so the whole history
  fits the column), plus a cash trend.
- **Events**: operations completing or failing, harvests with yields, frost
  and winterkill, and year-end summaries.
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
    AsciiGridRenderer.js      Canvas 2D drawing: field tint → glyphs → overlays
  transports/
    RendererTransport.js      transport contract (from biome)
    WebSocketRendererTransport.js  live stream, backoff reconnect (from biome)
  ui/                         status bar, controls, farm office, floating
                              field window, legend, markets, event log,
                              collapsible, columnResize
  styles/
    dracula.css               the Dracula Classic palette (single source of color)
    renderer.css              layout and panel styling (from biome)
```

The legend is **generated from `CellAppearance.js`**, so it cannot drift
from what the map draws; to reskin the sim, edit that one registry.

## Protocol

The host (`apps/server/src/ws.ts`) speaks the biome envelope over `/ws`:

- server → client: `{ type: 'snapshot.full' | 'events.batch' |
  'command.result' | 'error', payload, requestId? }`
- client → server: `{ type: 'command', requestId, command }`

Full frames only — no deltas. Each frame carries the whole map (appearance
codes + a static field-id map, both base64) plus tick/run state, calendar
date, weather and forecast, and the farm's structured state (fields, the
operation queue, equipment, markets, finance); the store replaces its world
on every frame, so a reconnect resynchronizes by construction. A change of
`simulationId` (a restart) drops selection, events, and history. Commands:
`simulation.pause/resume/setSpeed/step/restart`, `cell.inspect`, and
`farm.command` — an envelope whose inner command (`farm.op.schedule`,
`farm.op.cancel`, `farm.sell`, `farm.borrow`, `farm.repay`,
`farm.field.buy`, `farm.equip.buy`, `farm.labor.set`) the sim validates.

The renderer imports **nothing** from `@sim/runtime` or `@sim/farm` — it
speaks the protocol purely as message shapes over the transport
(`SUPPORTED_PROTOCOL_VERSION` in `state/RendererStore.js`).
