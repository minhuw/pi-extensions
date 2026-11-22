import { afterAll, beforeAll } from "vitest";

/** The Vcs inherits process.env; isolate it from the developer's global and system git configuration. */
export function isolateGitConfig(): void {
	const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
	beforeAll(() => {
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
	});
	afterAll(() => {
		for (const [name, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}
