// HTTP surface over a SimHost: control endpoints, an SSE state stream, and
// binary snapshot download/restore. The app is a thin adapter — all sim
// knowledge lives behind the SimHost's public methods.

import express from "express";
import type { SimHost } from "./host.js";

export interface AppOptions {
  /** SSE state-frame interval (default 500ms). */
  readonly sseIntervalMs?: number;
}

export function createApp(host: SimHost, opts: AppOptions = {}): express.Express {
  const sseIntervalMs = opts.sseIntervalMs ?? 500;
  const app = express();
  app.use(express.json());

  const fail = (res: express.Response, code: number, err: unknown): void => {
    res.status(code).json({ error: err instanceof Error ? err.message : String(err) });
  };

  app.get("/", (_req, res) => {
    res.json({
      name: "@sim/server",
      endpoints: [
        "GET  /sim/status",
        "POST /sim/start",
        "POST /sim/pause",
        "POST /sim/step",
        "PUT  /sim/speed        {\"speed\": number}",
        "POST /sim/spawn        {\"x\", \"y\", \"species\"}",
        "GET  /sim/snapshot     (binary)",
        "POST /sim/restore      (binary snapshot body)",
        "GET  /sim/stream       (SSE state frames)",
      ],
    });
  });

  app.get("/sim/status", (_req, res) => {
    res.json(host.status());
  });

  app.post("/sim/start", (_req, res) => {
    host.start();
    res.json(host.status());
  });

  app.post("/sim/pause", (_req, res) => {
    host.pause();
    res.json(host.status());
  });

  app.post("/sim/step", async (_req, res) => {
    try {
      await host.stepOnce();
      res.json(host.status());
    } catch (err) {
      fail(res, 409, err); // stepping requires a paused clock
    }
  });

  app.put("/sim/speed", (req, res) => {
    const speed = (req.body as { speed?: unknown }).speed;
    if (typeof speed !== "number") {
      fail(res, 400, new Error("body must be {\"speed\": number}"));
      return;
    }
    try {
      host.setSpeed(speed);
      res.json(host.status());
    } catch (err) {
      fail(res, 400, err);
    }
  });

  app.post("/sim/spawn", (req, res) => {
    try {
      host.spawn(req.body as Parameters<SimHost["spawn"]>[0]);
      res.json(host.status());
    } catch (err) {
      fail(res, 400, err);
    }
  });

  app.get("/sim/snapshot", (_req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(Buffer.from(host.snapshotBytes()));
  });

  app.post(
    "/sim/restore",
    express.raw({ type: "application/octet-stream", limit: "64mb" }),
    (req, res) => {
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        fail(res, 400, new Error("body must be a binary snapshot (application/octet-stream)"));
        return;
      }
      try {
        host.restoreBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
        res.json(host.status());
      } catch (err) {
        fail(res, 400, err);
      }
    },
  );

  app.get("/sim/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (): void => {
      res.write(`event: state\ndata: ${JSON.stringify(host.status())}\n\n`);
    };
    send();
    const timer = setInterval(send, sseIntervalMs);
    req.on("close", () => clearInterval(timer));
  });

  return app;
}
