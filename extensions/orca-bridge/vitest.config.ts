import { defineConfig } from "vitest/config";

// The plugin's native panel tests run explicitly through `orca plugin test`.
export default defineConfig({ test: { include: ["extensions/orca-bridge/tests/**/*.test.ts"] } });
