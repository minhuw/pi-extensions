import type { Model } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNativeCompaction } from "./native-compaction/lifecycle.ts";
import type { NativeCompactionConfig } from "./native-compaction/types.ts";
import { magpieModelName } from "./model-identity.ts";
import { resolveMagpieAlias } from "./model-aliases.ts";

export const COMPACTION_CONFIG_FILE = "magpie-native-compaction.json";

function readConfigFile(path: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let value: unknown;
	try { value = JSON.parse(text); }
	catch { throw new Error(`${path} must contain valid JSON.`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

export function loadMagpieCompactionConfig(
	cwd: string,
	projectTrusted: boolean,
	catalog: readonly Pick<Model<any>, "provider" | "api" | "id">[] = [],
): NativeCompactionConfig {
	const config: NativeCompactionConfig = {
		enabled: true,
		providerId: "magpie",
		apiId: "openai-responses",
		models: [...new Set(catalog.filter(model => {
			if (model.provider !== "magpie" || model.api !== "openai-responses") return false;
			const name = magpieModelName(model.id);
			return name !== undefined && /^(?:(?:gpt|chatgpt)-.+|o\d+(?:[-.].+)?)$/.test(name);
		}).map(model => model.id))],
		fallbackToBuiltin: true,
	};
	let explicitModels = false;
	const paths = [join(getAgentDir(), COMPACTION_CONFIG_FILE)];
	if (projectTrusted) paths.push(join(cwd, ".pi", COMPACTION_CONFIG_FILE));
	for (const path of paths) {
		const value = readConfigFile(path);
		if (!value) continue;
		for (const key of Object.keys(value)) {
			if (!["enabled", "models", "fallbackToBuiltin"].includes(key)) {
				throw new Error(`${path} has an unsupported configuration field.`);
			}
		}
		for (const key of ["enabled", "fallbackToBuiltin"] as const) {
			if (value[key] === undefined) continue;
			if (typeof value[key] !== "boolean") throw new Error(`${path}: ${key} must be a boolean.`);
			config[key] = value[key];
		}
		if (value.models !== undefined) {
			if (!Array.isArray(value.models) || value.models.some(id =>
				typeof id !== "string" || magpieModelName(id) === undefined,
			)) {
				throw new Error(`${path}: models must contain exact bare or qualified model IDs, not wildcard patterns.`);
			}
			config.models = [...new Set(value.models as string[])];
			explicitModels = true;
		}
	}
	if (explicitModels) {
		const names = new Set(config.models.map(magpieModelName));
		config.models = [...new Set([...config.models, ...catalog.filter(model =>
			model.provider === "magpie" && model.api === "openai-responses" &&
			names.has(magpieModelName(model.id)),
		).map(model => model.id)])];
	}
	return config;
}

export function registerMagpieCompaction(pi: ExtensionAPI): void {
	registerNativeCompaction(pi, {
		loadConfig: ctx => loadMagpieCompactionConfig(ctx.cwd, ctx.isProjectTrusted(), ctx.modelRegistry.getAll()),
		ownsProvider: providerId => providerId === "magpie",
		command: "magpie-native-compaction",
		label: "Magpie",
		resolveModel: resolveMagpieAlias,
	});
}
