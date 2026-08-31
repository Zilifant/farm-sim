// WebSocket layer for the farm renderer, speaking the same envelope the
// biome renderer's transport expects:
//
//   server → client:  { type: 'snapshot.full' | 'events.batch' |
//                       'command.result' | 'error', payload, requestId? }
//   client → server:  { type: 'command', requestId, command }
//
// Full frames only (no deltas): each frame carries the whole map as
// appearance codes plus the farm's structured state (fields, ops, markets,
// finance, weather) — small enough that delta bookkeeping would cost more
// than it saves. Frames are broadcast on an interval, and only when
// something changed; every (re)connection starts with a fresh full frame,
// which is what resynchronizes a client. This module is a thin adapter —
// all sim knowledge lives behind the SimHost's public methods.

import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { WORLD_HEIGHT, WORLD_WIDTH } from "@sim/farm";
import type { SimHost } from "./host.js";

export const RENDER_PROTOCOL_VERSION = 2;

export interface FarmSocketOptions {
  readonly path?: string;
  /** Broadcast cadence; a frame is only sent when the state moved. */
  readonly streamIntervalMs?: number;
}

interface CommandFrame {
  readonly type: "command";
  readonly requestId?: string;
  readonly command?: { readonly type?: string } & Record<string, unknown>;
}

function fullSnapshot(host: SimHost): object {
  const status = host.status();
  return {
    protocolVersion: RENDER_PROTOCOL_VERSION,
    simulationId: host.simulationId,
    seed: host.seed,
    tick: Number(status.tick),
    running: status.running,
    speed: status.speed,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    cells: host.cellsBase64(),
    fieldIds: host.fieldIdsBase64(),
    parcelIds: host.parcelIdsBase64(),
    date: host.date(),
    weather: host.weather(),
    forecast: host.forecast(5),
    fields: host.sim.fields(),
    parcels: host.sim.parcels(),
    ops: host.sim.ops(),
    equipment: host.sim.equipment(),
    markets: host.sim.markets(),
    finance: host.sim.finance(),
  };
}

function runReport(host: SimHost): object {
  const status = host.status();
  return {
    ok: true,
    tick: Number(status.tick),
    running: status.running,
    speed: status.speed,
    seed: host.seed,
    simulationId: host.simulationId,
  };
}

async function executeCommand(host: SimHost, command: NonNullable<CommandFrame["command"]>): Promise<object> {
  switch (command.type) {
    case "simulation.pause":
      host.pause();
      return runReport(host);
    case "simulation.resume":
      host.start();
      return runReport(host);
    case "simulation.setSpeed": {
      const multiplier = command["multiplier"];
      if (typeof multiplier !== "number") {
        return { ok: false, error: { code: "bad-request", message: "setSpeed needs a numeric multiplier" } };
      }
      host.setSpeed(multiplier);
      return runReport(host);
    }
    case "simulation.step": {
      if (host.clock.running) {
        return { ok: false, error: { code: "running", message: "pause before stepping" } };
      }
      await host.stepTicks(Number(command["ticks"] ?? 1));
      return runReport(host);
    }
    case "simulation.restart": {
      const seed = command["seed"];
      await host.restart(typeof seed === "number" ? seed : undefined);
      return runReport(host);
    }
    case "farm.command": {
      // The farm's whole player surface rides one envelope: the inner command
      // carries a `kind` the sim validates (schedule/cancel ops, sell,
      // borrow/repay, buy field/equipment, set workers).
      const inner = command["command"];
      if (typeof inner !== "object" || inner === null) {
        return { ok: false, error: { code: "bad-request", message: "farm.command needs a command object" } };
      }
      host.command(inner as Record<string, unknown>);
      return runReport(host);
    }
    case "cell.inspect": {
      const cell = host.cellInspect(Number(command["x"]), Number(command["y"]));
      return { ok: true, tick: Number(host.status().tick), cell };
    }
    default:
      return { ok: false, error: { code: "unknown-command", message: `unknown command type "${String(command.type)}"` } };
  }
}

/**
 * Attach the renderer socket to an HTTP server. Returns a handle whose
 * `close()` stops the broadcast timer and drops the clients — the SimHost is
 * untouched, in keeping with the server-dies-sim-lives boundary.
 */
export function attachFarmSockets(
  server: Server,
  host: SimHost,
  opts: FarmSocketOptions = {},
): { close(): void; clientCount(): number } {
  const wss = new WebSocketServer({ server, path: opts.path ?? "/ws" });
  const streamIntervalMs = opts.streamIntervalMs ?? 100;

  const send = (socket: WebSocket, frame: object): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };

  const sendEvents = (socket: WebSocket, sinceSeq: number): number => {
    const events = host.eventsSince(sinceSeq);
    if (events.length > 0) {
      send(socket, {
        type: "events.batch",
        payload: { simulationId: host.simulationId, events },
      });
      return events.at(-1)!.seq + 1;
    }
    return sinceSeq;
  };

  /** Per-client event watermark and the sim the client last saw. */
  const clients = new Map<WebSocket, { sinceSeq: number; simulationId: string }>();

  wss.on("connection", (socket) => {
    // A fresh full frame on every (re)connection resynchronizes the client;
    // recent event history follows so the log is not empty on arrival.
    send(socket, { type: "snapshot.full", payload: fullSnapshot(host) });
    const state = { sinceSeq: 1, simulationId: host.simulationId };
    state.sinceSeq = sendEvents(socket, state.sinceSeq);
    clients.set(socket, state);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (raw) => {
      void (async () => {
        let frame: CommandFrame;
        try {
          frame = JSON.parse(String(raw)) as CommandFrame;
        } catch {
          send(socket, { type: "error", payload: { code: "bad-json", message: "frames must be JSON" } });
          return;
        }
        if (frame?.type !== "command" || typeof frame.command?.type !== "string") {
          send(socket, { type: "error", payload: { code: "bad-frame", message: "expected { type: 'command', requestId, command }" } });
          return;
        }
        let payload: object;
        try {
          payload = await executeCommand(host, frame.command);
        } catch (err) {
          payload = { ok: false, error: { code: "command-failed", message: err instanceof Error ? err.message : String(err) } };
        }
        send(socket, { type: "command.result", requestId: frame.requestId ?? null, payload });
        // Commands change state out of band of the timer; follow with a frame
        // so every client (the sender included) sees the result immediately.
        broadcast(true);
      })();
    });
  });

  let lastSent = { tick: -1, running: false, speed: 0, simulationId: "" };
  function broadcast(force = false): void {
    const status = host.status();
    const now = {
      tick: Number(status.tick),
      running: status.running,
      speed: status.speed,
      simulationId: host.simulationId,
    };
    const moved =
      force ||
      now.tick !== lastSent.tick ||
      now.running !== lastSent.running ||
      now.speed !== lastSent.speed ||
      now.simulationId !== lastSent.simulationId;
    if (moved) {
      lastSent = now;
      const frame = { type: "snapshot.full", payload: fullSnapshot(host) };
      const text = JSON.stringify(frame);
      for (const socket of clients.keys()) {
        if (socket.readyState === socket.OPEN) {
          socket.send(text);
        }
      }
    }
    // Events flow on the same cadence, per-client from its watermark. A
    // client that saw a different simulationId (a restart) resets to the
    // fresh feed's start.
    for (const [socket, state] of clients) {
      if (state.simulationId !== host.simulationId) {
        state.simulationId = host.simulationId;
        state.sinceSeq = 1;
      }
      state.sinceSeq = sendEvents(socket, state.sinceSeq);
    }
  }

  const timer = setInterval(() => broadcast(), streamIntervalMs);

  return {
    close(): void {
      clearInterval(timer);
      for (const socket of clients.keys()) {
        socket.close();
      }
      wss.close();
    },
    clientCount(): number {
      return clients.size;
    },
  };
}
