// Demo driver: run Wa-Tor for a fixed number of ticks and print census,
// state hash, and per-system timings.
//   node packages/refsim/dist/main.js [seed] [ticks] [workers]
// With workers >= 1 the simulation runs region-partitioned across real
// worker threads; the state hash is identical either way.

import { createParallelWaTorSim } from "./parallel.js";
import { createWaTorSim } from "./index.js";

const seed = process.argv[2] ?? "demo";
const ticks = Number.parseInt(process.argv[3] ?? "1000", 10);
const workers = Number.parseInt(process.argv[4] ?? "0", 10);

if (workers >= 1) {
  const sim = await createParallelWaTorSim({ seed, workers });
  const startMs = performance.now();
  await sim.run(ticks);
  const elapsed = performance.now() - startMs;
  const { fish, sharks } = await sim.populations();
  const hash = await sim.stateHash();
  const stats = sim.stats();
  console.log(
    `Wa-Tor ${sim.config.width}x${sim.config.height}, seed "${seed}", ${ticks} ticks, ${workers} workers`,
  );
  console.log(`final populations: fish=${fish} sharks=${sharks}`);
  console.log(`state hash: 0x${hash.toString(16).padStart(8, "0")}`);
  console.log(`${((ticks / elapsed) * 1000).toFixed(0)} ticks/sec`);
  console.log(
    `messages: ${stats.perWorker.map((w) => `${w.mainPosts}→/${w.workerPosts}←`).join(" ")} over ${stats.ticks} ticks + ${stats.snapshots} snapshots`,
  );
  await sim.shutdown();
} else {
  const sim = await createWaTorSim({ seed });
  sim.run(ticks);

  const censusLines: string[] = [];
  sim.census.drain((e) => {
    censusLines.push(`  tick ${e.tick}: fish=${e.fish} sharks=${e.sharks}`);
  });

  const { fish, sharks } = sim.populations();
  console.log(`Wa-Tor ${sim.config.width}x${sim.config.height}, seed "${seed}", ${ticks} ticks`);
  console.log(`final populations: fish=${fish} sharks=${sharks}`);
  console.log(`state hash: 0x${sim.stateHash().toString(16).padStart(8, "0")}`);
  console.log("census (last 5):");
  for (const line of censusLines.slice(-5)) {
    console.log(line);
  }
  console.log("profile:");
  for (const t of sim.profiler.report()) {
    console.log(
      `  ${t.systemId}: p50=${t.p50Ms.toFixed(3)}ms p95=${t.p95Ms.toFixed(3)}ms ` +
        `max=${t.maxMs.toFixed(3)}ms (${t.samples} samples)`,
    );
  }
}
