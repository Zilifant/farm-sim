// node:worker_threads entry point for the SAB-mode Wa-Tor worker.

import { workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { PortLike, WorkerBootData } from "@sim/runtime";
import { setupWaTorSharedWorker } from "./wator-shared-worker.js";

const { port, boot } = workerData as { port: MessagePort; boot: WorkerBootData };
setupWaTorSharedWorker(port as unknown as PortLike, boot);
