// Throughput comparison: sequential vs message-passing borders vs SAB +
// Atomics barrier, at a given grid size and worker count.
//   node packages/refsim/dist/bench.js [size] [ticks] [workers]
// Phase 3 acceptance asks for SAB ≥ message-passing at ~1024² (grids must be
// multiples of 5, so 1020 stands in for 1024).

import { createWaTorSim } from "./index.js";
import { createParallelWaTorSim } from "./parallel.js";
import { createSharedWaTorSim } from "./parallel-shared.js";

const size = Number.parseInt(process.argv[2] ?? "300", 10);
const ticks = Number.parseInt(process.argv[3] ?? "200", 10);
const workers = Number.parseInt(process.argv[4] ?? "4", 10);
const cfg = { width: size, height: size, seed: "bench" };

function report(label: string, elapsedMs: number, hash: number): void {
  console.log(
    `${label.padEnd(24)} ${((ticks / elapsedMs) * 1000).toFixed(1).padStart(8)} ticks/sec  ` +
      `(${elapsedMs.toFixed(0)}ms, hash 0x${hash.toString(16).padStart(8, "0")})`,
  );
}

console.log(`Wa-Tor ${size}x${size}, ${ticks} ticks, ${workers} workers`);

{
  const sim = await createWaTorSim(cfg);
  const t0 = performance.now();
  sim.run(ticks);
  report("sequential", performance.now() - t0, sim.stateHash());
}

{
  const sim = await createParallelWaTorSim({ ...cfg, workers });
  const t0 = performance.now();
  await sim.run(ticks);
  const elapsed = performance.now() - t0;
  report(`message-passing x${workers}`, elapsed, await sim.stateHash());
  await sim.shutdown();
}

{
  const sim = await createSharedWaTorSim({ ...cfg, workers, batchTicks: ticks });
  const t0 = performance.now();
  await sim.run(ticks);
  const elapsed = performance.now() - t0;
  report(`sab+atomics x${workers}`, elapsed, sim.stateHash());
  await sim.shutdown();
}
