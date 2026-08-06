// Demo driver: run Wa-Tor for a fixed number of ticks and print census,
// state hash, and per-system timings.
//   node packages/refsim/dist/main.js [seed] [ticks]

import { createWaTorSim } from "./index.js";

const seed = process.argv[2] ?? "demo";
const ticks = Number.parseInt(process.argv[3] ?? "1000", 10);

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
