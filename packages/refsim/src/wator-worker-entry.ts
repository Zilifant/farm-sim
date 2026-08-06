// node:worker_threads entry point — spawned by NodeWorkerAdapter, which
// passes our end of a dedicated MessageChannel through workerData. Runs as
// compiled .js from dist (the repo's build-first workflow).

import { workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { PortLike, WorkerBootData } from "@sim/runtime";
import { setupWaTorWorker } from "./wator-worker.js";

const { port, boot } = workerData as { port: MessagePort; boot: WorkerBootData };
setupWaTorWorker(port as unknown as PortLike, boot);
