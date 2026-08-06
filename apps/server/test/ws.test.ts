// The renderer's WebSocket protocol, tested against a real listening server:
// full frames on connect and on change, the command envelope, census event
// batches, and restart semantics.

import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { SimHost, attachWaTorSockets, createApp } from "@sim/server";

interface Frame {
  type: string;
  requestId?: string | null;
  payload: Record<string, unknown> & {
    tick?: number;
    running?: boolean;
    speed?: number;
    seed?: number | string;
    simulationId?: string;
    species?: string;
    world?: { width: number; height: number };
    events?: Array<{ seq: number; type: string; tick: number; fish: number; sharks: number }>;
    ok?: boolean;
    cell?: { x: number; y: number; species: number; energy: number; breedAge: number };
    error?: { code: string; message: string };
  };
}

class TestClient {
  #socket: WebSocket;
  #open: Promise<void>;
  #frames: Frame[] = [];
  #waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  #nextRequest = 0;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#open = new Promise((resolve) => this.#socket.on("open", resolve));
    this.#socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      this.#frames.push(frame);
      const index = this.#waiters.findIndex((w) => w.match(frame));
      if (index >= 0) {
        const [waiter] = this.#waiters.splice(index, 1);
        waiter!.resolve(frame);
      }
    });
  }

  /** Next frame matching the predicate (or an already-received one). */
  frame(match: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const seen = this.#frames.find(match);
    if (seen) {
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  /** Frames received after this call only. */
  fresh(match: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const alreadySeen = this.#frames.length;
    return this.frame((f) => this.#frames.indexOf(f) >= alreadySeen && match(f), timeoutMs);
  }

  async command(command: object): Promise<Frame> {
    await this.#open;
    this.#nextRequest += 1;
    const requestId = `test-${this.#nextRequest}`;
    const reply = this.frame((f) => f.type === "command.result" && f.requestId === requestId);
    this.#socket.send(JSON.stringify({ type: "command", requestId, command }));
    return reply;
  }

  close(): void {
    this.#socket.close();
  }
}

interface Rig {
  host: SimHost;
  client: TestClient;
  close(): Promise<void>;
}

const open: Rig[] = [];

async function startRig(opts: { running?: boolean } = {}): Promise<Rig> {
  const host = await SimHost.create({ width: 30, height: 30, seed: 42, fixedDtMs: 2 });
  if (opts.running !== false) {
    host.start();
  }
  const server = await new Promise<Server>((resolve) => {
    const s = createApp(host).listen(0, () => resolve(s));
  });
  const sockets = attachWaTorSockets(server, host, { streamIntervalMs: 20 });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  const client = new TestClient(`ws://127.0.0.1:${address.port}/ws`);
  const rig: Rig = {
    host,
    client,
    close: () =>
      new Promise((resolve, reject) => {
        client.close();
        sockets.close();
        host.dispose();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  open.push(rig);
  return rig;
}

afterAll(async () => {
  for (const rig of open) {
    await rig.close().catch(() => undefined);
  }
});

describe("renderer WebSocket protocol", () => {
  it("sends a full frame on connect, and further frames as ticks advance", async () => {
    const { client } = await startRig();
    const first = await client.frame((f) => f.type === "snapshot.full");
    expect(first.payload.world).toEqual({ width: 30, height: 30 });
    expect(first.payload.seed).toBe(42);
    expect(first.payload.running).toBe(true);
    const species = Buffer.from(String(first.payload.species), "base64");
    expect(species.length).toBe(900);
    expect(new Set(species).size).toBeGreaterThan(1); // seeded, not blank

    const later = await client.fresh(
      (f) => f.type === "snapshot.full" && Number(f.payload.tick) > Number(first.payload.tick),
    );
    expect(Number(later.payload.tick)).toBeGreaterThan(Number(first.payload.tick));
  }, 15_000);

  it("executes pause / speed / step commands over the socket", async () => {
    const { client } = await startRig();
    const paused = await client.command({ type: "simulation.pause" });
    expect(paused.payload.ok).toBe(true);
    expect(paused.payload.running).toBe(false);

    const tickAtPause = Number(paused.payload.tick);
    const stepped = await client.command({ type: "simulation.step", ticks: 7 });
    expect(stepped.payload.ok).toBe(true);
    expect(Number(stepped.payload.tick)).toBe(tickAtPause + 7);

    const sped = await client.command({ type: "simulation.setSpeed", multiplier: 4 });
    expect(sped.payload.speed).toBe(4);

    // Stepping while running is refused (the renderer pauses first).
    await client.command({ type: "simulation.resume" });
    const refused = await client.command({ type: "simulation.step", ticks: 1 });
    expect(refused.payload.ok).toBe(false);
    expect(refused.payload.error?.code).toBe("running");
  }, 15_000);

  it("answers cell.inspect with values consistent with the frame", async () => {
    const { client } = await startRig({ running: false });
    const frame = await client.frame((f) => f.type === "snapshot.full");
    const species = Buffer.from(String(frame.payload.species), "base64");
    const occupied = species.findIndex((s) => s !== 0);
    const x = occupied % 30;
    const y = Math.floor(occupied / 30);
    const inspected = await client.command({ type: "cell.inspect", x, y });
    expect(inspected.payload.ok).toBe(true);
    expect(inspected.payload.cell?.species).toBe(species[occupied]);
    expect(inspected.payload.cell?.breedAge).toBeGreaterThanOrEqual(0);

    const outOfRange = await client.command({ type: "cell.inspect", x: 99, y: 0 });
    expect(outOfRange.payload.ok).toBe(false);
  }, 15_000);

  it("streams census events with monotonic seqs", async () => {
    const { client } = await startRig();
    const batch = await client.frame((f) => f.type === "events.batch");
    const events = batch.payload.events!;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("census");
    expect(events[0]!.fish).toBeGreaterThan(0);
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  }, 15_000);

  it("restart changes the simulationId and resets the tick", async () => {
    const { client } = await startRig();
    const before = await client.frame((f) => f.type === "snapshot.full");
    const restarted = await client.command({ type: "simulation.restart", seed: 7 });
    expect(restarted.payload.ok).toBe(true);
    expect(restarted.payload.seed).toBe(7);
    expect(restarted.payload.simulationId).not.toBe(before.payload.simulationId);

    const fresh = await client.fresh(
      (f) => f.type === "snapshot.full" && f.payload.simulationId === restarted.payload.simulationId,
    );
    expect(Number(fresh.payload.tick)).toBeLessThan(50); // the new world starts over
  }, 15_000);

  it("rejects malformed frames and unknown commands without dying", async () => {
    const { client } = await startRig();
    const bad = await client.command({ type: "no.such.command" });
    expect(bad.payload.ok).toBe(false);
    expect(bad.payload.error?.code).toBe("unknown-command");
    // The socket is still serving after the error.
    const ok = await client.command({ type: "simulation.pause" });
    expect(ok.payload.ok).toBe(true);
  }, 15_000);
});
