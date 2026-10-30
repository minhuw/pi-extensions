import { defineConfig } from "vitest/config";

/**
 * Scoped offline suite for the Impeccable extension. Contract tests exercise package
 * loading through Pi's DefaultResourceLoader, native template expansion, relocation, and
 * source/provenance coverage. Runtime and e2e suites arrive in later tasks; the pristine
 * vendor snapshot and explicit e2e drivers are never picked up here.
 */
export default defineConfig({
	test: {
		include: ["extensions/impeccable/tests/**/*.test.ts"],
		exclude: [
			"extensions/impeccable/tests/e2e/**",
			"extensions/impeccable/vendor/**",
			"**/node_modules/**",
		],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
