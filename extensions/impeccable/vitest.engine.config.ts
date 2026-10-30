import { defineConfig } from "vitest/config";

/** Explicit opt-in: downloads only the checksum-pinned engine, never browsers. */
export default defineConfig({
	test: {
		include: ["extensions/impeccable/tests/e2e/engine-parity.test.ts", "extensions/impeccable/tests/e2e/live-engine.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
