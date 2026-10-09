import { parentPort, workerData } from "node:worker_threads";
import type { Scan } from "./model.js";
import { analyze } from "./analysis.js";

// This private entrypoint receives only the scanner's validated, structured-cloned checkpoint.
const scan: Scan = workerData;
if (!parentPort) throw new Error("Network analysis requires a worker thread.");
parentPort.postMessage(analyze(scan));
