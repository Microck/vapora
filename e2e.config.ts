import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
export default {
 tests: "tests/e2e/**/*.e2e.ts", workers: 1, retries: 0, timeout: 60_000,
 targets: [{ name: "chromium", engine: web({viewport:{width:1078,height:800}}), app: {
  url: "http://127.0.0.1:4178",
  command: { executable: "node", args: ["tools/e2e-server.mjs"] },
 } }],
} satisfies E2EConfig;
