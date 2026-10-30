import { defineConfig } from "vitest/config";

/** Explicit offline npm distribution check; never included by the scoped suite. */
export default defineConfig({
	test: {
		include: ["extensions/impeccable/tests/package/**/*.test.ts"],
		passWithNoTests: false,
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
