import path from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/** The final gate must not turn green after filtering, emptying or skipping a required phase. */
export class RequiredCoverage implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]) {
		for (const [file, minimum] of Object.entries({
			"engine-parity.test.ts": 1,
			"live-engine.test.ts": 1,
			"visual-foundations.test.ts": 3,
			"live-browser.test.ts": 1,
		})) {
			const module = modules.find((entry) => path.basename(entry.moduleId) === file);
			const tests = module ? [...module.children.allTests()] : [];
			if (tests.length < minimum || tests.some((test) => test.result().state !== "passed")) {
				throw new Error(`Required Impeccable E2E phase missing, empty, skipped or failed: ${file} (requires ${minimum} passed tests)`);
			}
		}
	}
}
