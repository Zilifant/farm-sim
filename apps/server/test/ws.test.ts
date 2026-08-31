// The renderer's WebSocket protocol, tested against a real listening server:
// full frames on connect and on change, the command envelope, farm event
// batches, and restart semantics.

import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { SimHost, attachFarmSockets, createApp } from "@sim/server";

interface Frame {
  type: string;
  requestId?: string | null;
  payload: Record<string, unknown> & {
    tick?: number;
    running?: boolean;
    speed?: number;
    seed?: number | string;
    simulationId?: string;
    cells?: string;
    fieldIds?: string;
    parcelIds?: string;
    world?: { width: number; height: number };
    fields?: Array<{ id: number; name: string; acres: number; x: number; y: number; w: number; h: number }>;
    parcels?: Array<{ id: number; name: string; owned: boolean; acres: number; price: number }>;
    ops?: Array<{ seq: number; kind: string }>;
    markets?: Array<{ key: string; price: number }>;
    finance?: { cash: number; debt: number };
    events?: Array<{ seq: number; kind: string; tick: number; message: string }>;
    ok?: boolean;
    cell?: {
      x: number; y: number; kind: string;
      field: { name: string; moisture: number } | null;
      parcel: { id: number; owned: boolean } | null;
      soilQuality: number;
    };
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
  const host = await SimHost.create({ seed: 42, fixedDtMs: 2 });
  if (opts.running !== false) {
    host.start();
  }
  const server = await new Promise<Server>((resolve) => {
    const s = createApp(host).listen(0, () => resolve(s));
  });
  const sockets = attachFarmSockets(server, host, { streamIntervalMs: 20 });
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
  it("sends a full frame on connect, and further frames as days advance", async () => {
    const { client } = await startRig();
    const first = await client.frame((f) => f.type === "snapshot.full");
    expect(first.payload.world).toEqual({ width: 96, height: 56 });
    expect(first.payload.seed).toBe(42);
    expect(first.payload.running).toBe(true);
    const cells = Buffer.from(String(first.payload.cells), "base64");
    expect(cells.length).toBe(96 * 56);
    expect(new Set(cells).size).toBeGreaterThan(1); // owned/unowned ground, road, farmstead
    const fieldIds = Buffer.from(String(first.payload.fieldIds), "base64");
    expect(fieldIds.length).toBe(96 * 56);
    expect(new Set(fieldIds)).toEqual(new Set([255])); // no fields yet — the player places them
    const parcelIds = Buffer.from(String(first.payload.parcelIds), "base64");
    expect(parcelIds.length).toBe(96 * 56);
    expect(first.payload.fields!.length).toBe(0);
    expect(first.payload.parcels!.length).toBe(16);
    expect(first.payload.parcels!.filter((p) => p.owned)).toHaveLength(1); // the homestead
    expect(first.payload.markets!.length).toBe(6);
    expect(first.payload.finance!.cash).toBeGreaterThan(0);

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

  it("executes farm commands through the farm.command envelope", async () => {
    const { client } = await startRig({ running: false });
    const borrowed = await client.command({
      type: "farm.command",
      command: { kind: "farm.borrow", amount: 25_000 },
    });
    expect(borrowed.payload.ok).toBe(true);
    // Commands force a broadcast; match on content so arrival order is moot.
    const frame = await client.frame(
      (f) => f.type === "snapshot.full" && (f.payload.finance?.debt ?? 0) > 200_000,
    );
    expect(frame.payload.finance!.debt).toBeGreaterThan(200_000); // start debt + loan

    const created = await client.command({
      type: "farm.command",
      command: { kind: "farm.field.create", x: 24, y: 0, w: 12, h: 9 },
    });
    expect(created.payload.ok).toBe(true);
    const withField = await client.frame(
      (f) => f.type === "snapshot.full" && (f.payload.fields ?? []).length > 0,
    );
    expect(withField.payload.fields![0]!).toMatchObject({ x: 24, y: 0, w: 12, h: 9, acres: 54 });

    const rejected = await client.command({
      type: "farm.command",
      command: { kind: "farm.field.create", x: 0, y: 0, w: 6, h: 6 }, // unowned parcel
    });
    expect(rejected.payload.ok).toBe(false);
    expect(rejected.payload.error?.message).toMatch(/not yours/);

    const scheduled = await client.command({
      type: "farm.command",
      command: { kind: "farm.op.schedule", op: 1, field: 0, crop: 1 },
    });
    expect(scheduled.payload.ok).toBe(true);
    const withOp = await client.frame(
      (f) => f.type === "snapshot.full" && (f.payload.ops ?? []).some((op) => op.kind === "plant"),
    );
    expect(withOp.payload.ops!.some((op) => op.kind === "plant")).toBe(true);

    // Invalid commands come back as structured failures, not socket errors.
    const refused = await client.command({
      type: "farm.command",
      command: { kind: "farm.sell", crop: 1, units: 100 },
    });
    expect(refused.payload.ok).toBe(false);
    expect(refused.payload.error?.code).toBe("command-failed");
    const unknown = await client.command({
      type: "farm.command",
      command: { kind: "farm.no.such" },
    });
    expect(unknown.payload.ok).toBe(false);
  }, 15_000);

  it("answers cell.inspect for fields, parcels, and terrain", async () => {
    const { client } = await startRig({ running: false });
    await client.command({
      type: "farm.command",
      command: { kind: "farm.field.create", x: 24, y: 0, w: 6, h: 6 },
    });
    const inspected = await client.command({ type: "cell.inspect", x: 26, y: 2 });
    expect(inspected.payload.ok).toBe(true);
    expect(inspected.payload.cell?.kind).toBe("field");
    expect(inspected.payload.cell?.field?.name).toBe("Field 1");
    expect(inspected.payload.cell?.field?.moisture).toBeGreaterThan(0);
    expect(inspected.payload.cell?.soilQuality).toBeGreaterThan(0.5);

    // Open ground on an unowned parcel reports the parcel, no field.
    const grass = await client.command({ type: "cell.inspect", x: 2, y: 2 });
    expect(grass.payload.ok).toBe(true);
    expect(grass.payload.cell?.kind).toBe("grass");
    expect(grass.payload.cell?.field).toBeNull();
    expect(grass.payload.cell?.parcel?.owned).toBe(false);

    // The road belongs to no parcel.
    const road = await client.command({ type: "cell.inspect", x: 10, y: 27 });
    expect(road.payload.cell?.kind).toBe("road");
    expect(road.payload.cell?.parcel).toBeNull();

    const outOfRange = await client.command({ type: "cell.inspect", x: 999, y: 0 });
    expect(outOfRange.payload.ok).toBe(false);
  }, 15_000);

  it("streams farm events with monotonic seqs once operations run", async () => {
    const { client } = await startRig();
    // A small field beside the public road (reachable with no dirt roads),
    // then a fertilizer pass with capacity to spare — the op completes
    // within a few simulated days.
    await client.command({
      type: "farm.command",
      command: { kind: "farm.field.create", x: 24, y: 24, w: 6, h: 3 },
    });
    await client.command({
      type: "farm.command",
      command: { kind: "farm.op.schedule", op: 2, field: 0, crop: 0 },
    });
    const batch = await client.frame(
      (f) => f.type === "events.batch" && (f.payload.events ?? []).some((e) => e.kind === "op"),
      10_000,
    );
    const events = batch.payload.events!;
    expect(events.length).toBeGreaterThan(0);
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(events.some((e) => e.message.includes("fertilized"))).toBe(true);
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
    expect(Number(fresh.payload.tick)).toBeLessThan(50); // the new farm starts over
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
