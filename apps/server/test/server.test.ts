// Phase 8 acceptance: the server controls a running sim via public API
// only; killing the HTTP server leaves the sim unaffected; snapshot bytes
// round-trip over HTTP. Tests hit a real listening server with fetch.

import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { decodeSnapshot } from "@sim/runtime";
import { SimHost, createApp, type SimStatus } from "@sim/server";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TestServer {
  host: SimHost;
  server: Server;
  url: string;
  close(): Promise<void>;
}

const open: TestServer[] = [];

async function startServer(): Promise<TestServer> {
  // Small fixedDtMs so ticks accumulate quickly in wall time.
  const host = await SimHost.create({ width: 30, height: 30, seed: "server", fixedDtMs: 2 });
  const app = createApp(host, { sseIntervalMs: 25 });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  const ts: TestServer = {
    host,
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        host.dispose();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  open.push(ts);
  return ts;
}

afterAll(async () => {
  for (const ts of open) {
    await ts.close().catch(() => undefined);
  }
});

async function getStatus(url: string): Promise<SimStatus> {
  const res = await fetch(`${url}/sim/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as SimStatus;
}

describe("sim control endpoints", () => {
  it("start/pause/speed/step drive the clock", async () => {
    const { url } = await startServer();

    expect((await getStatus(url)).running).toBe(false);

    await fetch(`${url}/sim/start`, { method: "POST" });
    await sleep(80);
    const running = await getStatus(url);
    expect(running.running).toBe(true);
    expect(BigInt(running.tick)).toBeGreaterThan(0n);

    await fetch(`${url}/sim/pause`, { method: "POST" });
    const paused = await getStatus(url);
    await sleep(60);
    expect((await getStatus(url)).tick).toBe(paused.tick); // frozen

    const stepped = (await (
      await fetch(`${url}/sim/step`, { method: "POST" })
    ).json()) as SimStatus;
    expect(BigInt(stepped.tick)).toBe(BigInt(paused.tick) + 1n);

    const sped = await fetch(`${url}/sim/speed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: 4 }),
    });
    expect(((await sped.json()) as SimStatus).speed).toBe(4);

    const bad = await fetch(`${url}/sim/speed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speed: -1 }),
    });
    expect(bad.status).toBe(400);
  });

  it("step while running is a conflict; spawn validates input", async () => {
    const { url } = await startServer();
    await fetch(`${url}/sim/start`, { method: "POST" });
    expect((await fetch(`${url}/sim/step`, { method: "POST" })).status).toBe(409);
    await fetch(`${url}/sim/pause`, { method: "POST" });

    const ok = await fetch(`${url}/sim/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 3, y: 4, species: 2 }),
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${url}/sim/spawn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 999, y: 4, species: 2 }),
    });
    expect(bad.status).toBe(400);
  });

  it("snapshots round-trip over HTTP as binary", async () => {
    const { url } = await startServer();
    await fetch(`${url}/sim/start`, { method: "POST" });
    await sleep(60);
    await fetch(`${url}/sim/pause`, { method: "POST" });

    const res = await fetch(`${url}/sim/snapshot`);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const snapshot = decodeSnapshot(bytes);
    const at = await getStatus(url);
    expect(snapshot.tick.toString()).toBe(at.tick);

    // Advance past the capture point, then restore the bytes.
    const stepped = await fetch(`${url}/sim/step`, { method: "POST" });
    expect(stepped.status).toBe(200);
    const restored = await fetch(`${url}/sim/restore`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(restored.status).toBe(200);
    const after = await getStatus(url);
    expect(after.tick).toBe(at.tick);
    expect(after.stateHash).toBe(at.stateHash);

    const garbage = await fetch(`${url}/sim/restore`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(garbage.status).toBe(400);
  });

  it("streams SSE state frames", async () => {
    const { url } = await startServer();
    await fetch(`${url}/sim/start`, { method: "POST" });
    const ac = new AbortController();
    const res = await fetch(`${url}/sim/stream`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    expect(text).toContain("event: state");
    const frame = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!) as SimStatus;
    expect(frame.running).toBe(true);
    expect(frame.stateHash).toMatch(/^0x[0-9a-f]{8}$/);
  });
});

describe("isolation (Phase 8 acceptance)", () => {
  it("killing the HTTP server leaves the sim ticking", async () => {
    const ts = await startServer();
    await fetch(`${ts.url}/sim/start`, { method: "POST" });
    await sleep(40);

    // Close ONLY the HTTP listener — not the host.
    await new Promise<void>((resolve, reject) => {
      ts.server.close((err) => (err ? reject(err) : resolve()));
    });
    await expect(fetch(`${ts.url}/sim/status`)).rejects.toThrow(); // server is gone

    const tickAtClose = ts.host.sim.tick;
    await sleep(60);
    expect(ts.host.sim.tick).toBeGreaterThan(tickAtClose); // sim unaffected
    expect(ts.host.clock.running).toBe(true);
    ts.host.dispose();
  });
});
