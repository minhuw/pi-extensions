import { defineConfig } from "vitest/config";

// Herder's suites drive real git repositories, worktrees, and check processes; under a loaded machine a single test can
// take well over Vitest's 5 s default.
export default defineConfig({
	test: {
		include: ["extensions/herder/tests/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
