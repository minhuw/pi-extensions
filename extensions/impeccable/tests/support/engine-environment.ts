import { afterEach, beforeEach } from "vitest";

/** Engine tests must never consume a developer's trusted override or cache/download settings. */
export function isolateEngineEnvironment(): void {
	const names = ["IMPECCABLE_BIN", "IMPECCABLE_HOME", "IMPECCABLE_DOWNLOAD_BASE", "IMPECCABLE_PROVIDER_ID", "IMPECCABLE_CONTEXT_DIR", "IMPECCABLE_CACHE_ROOT", "IMPECCABLE_HOOK_DISABLED", "IMPECCABLE_HOOK_QUIET", "IMPECCABLE_HOOK_LOG", "IMPECCABLE_HOOK_DEPTH", "CLAUDE_HOOK_DEPTH", "IMPECCABLE_HOOK_HARNESS", "IMPECCABLE_HOOK_COMPLETION_ONLY", "IMPECCABLE_HOOK_SESSION_DIR", "IMPECCABLE_HOOK_CLAIM_DIR"];
	let previous: Array<string | undefined>;
	beforeEach(() => {
		previous = names.map((name) => process.env[name]);
		for (const name of names) delete process.env[name];
	});
	afterEach(() => {
		names.forEach((name, index) => {
			if (previous[index] === undefined) delete process.env[name];
			else process.env[name] = previous[index];
		});
	});
}
