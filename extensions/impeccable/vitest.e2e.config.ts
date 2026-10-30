import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { RequiredCoverage } from "./tests/e2e/required-coverage.ts";

const required = ["engine-parity.test.ts", "live-engine.test.ts", "visual-foundations.test.ts", "live-browser.test.ts", "foundations.ts", "detector-phase.ts", "direction-phase.ts"];
for (const file of required) {
	if (!existsSync(fileURLToPath(new URL(`./tests/e2e/${file}`, import.meta.url)))) throw new Error(`Required Impeccable E2E coverage missing: ${file}`);
}

/** Explicit opt-in: real native protocol, detector/direction and browser live transactions. */
export default defineConfig({
	test: {
		include: [
			"extensions/impeccable/tests/e2e/engine-parity.test.ts",
			"extensions/impeccable/tests/e2e/live-engine.test.ts",
			"extensions/impeccable/tests/e2e/visual-foundations.test.ts",
			"extensions/impeccable/tests/e2e/live-browser.test.ts",
		],
		fileParallelism: false,
		reporters: ["default", new RequiredCoverage()],
		passWithNoTests: false,
		testTimeout: 180_000,
		hookTimeout: 780_000,
	},
});
