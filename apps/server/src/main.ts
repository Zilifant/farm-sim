// Entry point: host the farm sim, serve the control API, the browser
// renderer, and the renderer's WebSocket stream.
//   PORT=3000 node apps/server/dist/main.js [seed]

import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";
import { SimHost } from "./host.js";
import { attachFarmSockets } from "./ws.js";

const host = await SimHost.create({ seed: process.argv[2] ?? "server" });
host.start();

const app = createApp(host);
// The renderer is plain browser ES modules served statically — no build step,
// exactly as the biome renderer is served.
app.use("/renderer", express.static(fileURLToPath(new URL("../renderer", import.meta.url))));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

const port = Number(process.env["PORT"] ?? 3000);
const server = app.listen(port, () => {
  console.log(`@sim/server listening on http://localhost:${port} — renderer at /, endpoints at GET /api`);
});
const sockets = attachFarmSockets(server, host);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sockets.close();
    server.close();
    host.dispose();
  });
}
