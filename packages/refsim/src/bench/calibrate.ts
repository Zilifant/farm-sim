// A fixed CPU-bound workload (FNV-1a over 1 MiB) timed for ~250ms. Baseline
// metrics are stored normalized by this score, which partially cancels
// machine-speed differences so a baseline recorded on one box remains
// meaningful (with a generous tolerance) on another.

import { fnv1a32 } from "@sim/runtime";

export function calibrate(): number {
  const buf = new Uint8Array(1 << 20);
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] = (i * 31) & 0xff;
  }
  for (let i = 0; i < 10; i += 1) {
    fnv1a32(buf); // warmup / JIT
  }
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < 250) {
    fnv1a32(buf);
    n += 1;
  }
  return n / ((performance.now() - t0) / 1000);
}
