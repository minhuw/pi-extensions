import { defineConfig } from "vitest/config";

/** Explicit network/browser opt-in; excluded from the safe collection suite. */
export default defineConfig({
	test: {
		include: ["extensions/impeccable/tests/e2e/visual-foundations.test.ts"],
		fileParallelism: false,
		passWithNoTests: false,
		testTimeout: 120_000,
		hookTimeout: 780_000,
	},
});
