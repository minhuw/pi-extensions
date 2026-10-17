import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
    pool: "forks", // The hermetic integration harnesses change process.cwd().
    maxWorkers: 4,
    env: { PI_E2E_LIVE: "0" },
    // Faux parent and child sessions must share the same provider registry.
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
