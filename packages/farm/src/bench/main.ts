// Benchmark CLI.
//   node packages/farm/dist/bench/main.js run    [--full]
//   node packages/farm/dist/bench/main.js record [--full] [--baseline <path>]
//   node packages/farm/dist/bench/main.js check  [--tolerance 0.2] [--baseline <path>]
// `check` re-measures the quick set and fails (exit 1) when a metric's
// calibration-normalized value regresses beyond the tolerance
// (BENCH_TOLERANCE env overrides; CI uses a loose one — shared runners and
// cross-machine baselines are noisy, as the plan anticipates).

import { fileURLToPath } from "node:url";
import { calibrate } from "./calibrate.js";
import { runAll } from "./metrics.js";
import {
  compareToBaseline,
  loadBaseline,
  saveBaseline,
  toBaseline,
} from "./baseline.js";

const DEFAULT_BASELINE = fileURLToPath(new URL("../../../../bench/baselines.json", import.meta.url));

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const command = process.argv[2] ?? "run";
const full = flag("full");
const baselinePath = option("baseline") ?? DEFAULT_BASELINE;
const tolerance = Number.parseFloat(
  option("tolerance") ?? process.env["BENCH_TOLERANCE"] ?? "0.2",
);

const fmt = (v: number): string =>
  v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2);

if (command === "run" || command === "record") {
  const calibration = calibrate();
  console.log(`calibration: ${fmt(calibration)} ops/sec (fnv1a32 over 1 MiB)`);
  const results = await runAll(full);
  for (const r of results) {
    const p95 = r.p95TickMs !== undefined ? `  p95 ${r.p95TickMs.toFixed(3)}ms` : "";
    console.log(`${r.id.padEnd(32)} ${fmt(r.value).padStart(14)} ${r.unit}${p95}`);
  }
  if (command === "record") {
    await saveBaseline(baselinePath, toBaseline(results, calibration));
    console.log(`\nbaseline written to ${baselinePath}`);
  }
} else if (command === "check") {
  if (Number.isNaN(tolerance) || tolerance <= 0) {
    throw new Error("tolerance must be a positive number");
  }
  const baseline = await loadBaseline(baselinePath);
  const calibration = calibrate();
  const results = await runAll(false); // quick set only
  const cmp = compareToBaseline(baseline, results, calibration, tolerance);
  console.log(
    `baseline ${baseline.recordedAt} (${baseline.machine.cpus} cpus, ${baseline.machine.node}); ` +
      `tolerance ±${(tolerance * 100).toFixed(0)}%` +
      (cmp.cpusDiffer ? " — NOTE: cpu count differs from baseline machine" : ""),
  );
  for (const row of cmp.rows) {
    const ratio = row.ratio === null ? "   new" : `${(row.ratio * 100).toFixed(0).padStart(4)}%`;
    const marker = row.status === "regression" ? " ← REGRESSION" : row.status === "improved" ? " (improved)" : "";
    console.log(
      `${row.id.padEnd(32)} ${fmt(row.candidateValue).padStart(14)} ${row.unit}  vs baseline ${ratio}${marker}`,
    );
  }
  if (cmp.regressions > 0) {
    console.error(`\n${cmp.regressions} metric(s) regressed beyond tolerance`);
    process.exit(1);
  }
  console.log("\nno regressions beyond tolerance");
} else {
  console.error(`unknown command "${command}" — use run, record, or check`);
  process.exit(2);
}
