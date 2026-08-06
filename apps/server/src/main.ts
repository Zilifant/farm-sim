// Entry point: host a Wa-Tor sim and serve the control API.
//   PORT=3000 node apps/server/dist/main.js [seed]

import { createApp } from "./app.js";
import { SimHost } from "./host.js";

const host = await SimHost.create({ seed: process.argv[2] ?? "server" });
host.start();

const app = createApp(host);
const port = Number(process.env["PORT"] ?? 3000);
const server = app.listen(port, () => {
  console.log(`@sim/server listening on http://localhost:${port} — GET / for endpoints`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    host.dispose();
  });
}
