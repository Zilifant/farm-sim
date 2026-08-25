// Baseline persistence and regression comparison. Metrics are compared via
// their calibration-normalized values, so a baseline recorded on one machine
// stays meaningful on another; raw values and machine info are kept for
// humans. A candidate is a regression when its normalized value falls more
// than `tolerance` below the baseline's.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import type { MetricResult } from "./metrics.js";

export interface BaselineMetric {
  readonly value: number;
  readonly unit: string;
  readonly perCalibration: number;
  readonly p95TickMs?: number;
}

export interface BaselineFile {
  readonly version: 1;
  readonly recordedAt: string;
  readonly machine: { cpus: number; model: string; node: string };
  readonly calibrationOpsPerSec: number;
  readonly metrics: Record<string, BaselineMetric>;
}

export function toBaseline(results: readonly MetricResult[], calibration: number): BaselineFile {
  const metrics: Record<string, BaselineMetric> = {};
  for (const r of results) {
    metrics[r.id] = {
      value: r.value,
      unit: r.unit,
      perCalibration: r.value / calibration,
      ...(r.p95TickMs !== undefined ? { p95TickMs: r.p95TickMs } : {}),
    };
  }
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    machine: {
      cpus: os.cpus().length,
      model: os.cpus()[0]?.model ?? "unknown",
      node: process.version,
    },
    calibrationOpsPerSec: calibration,
    metrics,
  };
}

export async function saveBaseline(path: string, baseline: BaselineFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export async function loadBaseline(path: string): Promise<BaselineFile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as BaselineFile;
  if (parsed.version !== 1) {
    throw new Error(`unsupported baseline version ${String(parsed.version)}`);
  }
  return parsed;
}

export type ComparisonStatus = "ok" | "regression" | "improved" | "new";

export interface ComparisonRow {
  readonly id: string;
  readonly status: ComparisonStatus;
  /** candidate normalized / baseline normalized; 1.0 = unchanged. */
  readonly ratio: number | null;
  readonly baselineValue: number | null;
  readonly candidateValue: number;
  readonly unit: string;
}

export interface Comparison {
  readonly rows: ComparisonRow[];
  readonly regressions: number;
  readonly cpusDiffer: boolean;
}

export function compareToBaseline(
  baseline: BaselineFile,
  results: readonly MetricResult[],
  calibration: number,
  tolerance: number,
): Comparison {
  const rows: ComparisonRow[] = [];
  let regressions = 0;
  for (const r of results) {
    const base = baseline.metrics[r.id];
    if (base === undefined) {
      rows.push({ id: r.id, status: "new", ratio: null, baselineValue: null, candidateValue: r.value, unit: r.unit });
      continue;
    }
    const ratio = r.value / calibration / base.perCalibration;
    let status: ComparisonStatus = "ok";
    if (ratio < 1 - tolerance) {
      status = "regression";
      regressions += 1;
    } else if (ratio > 1 + tolerance) {
      status = "improved";
    }
    rows.push({ id: r.id, status, ratio, baselineValue: base.value, candidateValue: r.value, unit: r.unit });
  }
  return {
    rows,
    regressions,
    cpusDiffer: os.cpus().length !== baseline.machine.cpus,
  };
}
