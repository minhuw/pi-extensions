import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerHerderPiWithWorkerFactory } from "../../../adapters/index.ts";
import type { PiWorkerSessionFactory } from "../../../adapters/worker-engine.ts";

type CapturedHandler = (...args: unknown[]) => unknown;

type CapturedTool = {
	name: string;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<unknown>;
};

class CapturedExtensionAPI {
	readonly commands = new Map<string, unknown>();
	readonly tools: CapturedTool[] = [];
	readonly handlers = new Map<string, CapturedHandler>();
	readonly renderers: string[] = [];

	on(event: string, handler: CapturedHandler): void {
		this.handlers.set(event, handler);
	}

	registerCommand(name: string, options: unknown): void {
		this.commands.set(name, options);
	}

	registerTool(tool: unknown): void {
		this.tools.push(tool as CapturedTool);
	}

	registerEntryRenderer(customType: string, _renderer: unknown): void {
		this.renderers.push(customType);
	}

	async invoke(event: string, ...args: unknown[]): Promise<unknown> {
		const handler = this.handlers.get(event);
		if (!handler) throw new Error(`No captured ${event} handler`);
		return await handler(...args);
	}

	tool(name: string): CapturedTool {
		const tool = this.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`No captured ${name} tool`);
		return tool;
	}
}

function workerFactory(): PiWorkerSessionFactory {
	return {
		availableModels: async () => [],
		create: async () => {
			throw new Error("Unexpected worker creation during adapter registration characterization");
		},
	};
}

function captureAdapter(): CapturedExtensionAPI {
	const api = new CapturedExtensionAPI();
	registerHerderPiWithWorkerFactory(api as unknown as ExtensionAPI, workerFactory());
	return api;
}

function context(isTrusted: boolean): ExtensionContext {
	return { isProjectTrusted: () => isTrusted } as unknown as ExtensionContext;
}

function record(value: unknown): Record<string, unknown> {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

async function rejectsMessage(operation: () => Promise<unknown>, expected: string): Promise<void> {
	await assert.rejects(operation, (error: unknown) => error instanceof Error && error.message === expected);
}

const runToolParameters = {
	integration: {
		planDirectory: "herder-plans",
		operation: "cancel",
		requestId: "request-001",
		requestSha256: "request-sha",
		capabilityToken: "capability-token",
		ownerSessionId: "session-001",
	},
	verification: {
		planDirectory: "herder-plans",
		requestId: "request-001",
		rationale: "Characterize the adapter safety gate.",
		gates: [{ gateId: "unit", label: "unit", cwd: ".", argv: ["true"], rationale: "A valid-enough gate." }],
	},
	reignite: {
		planDirectory: "herder-plans",
		requestId: "request-001",
		requestSha256: "request-sha",
		state: "failed",
	},
} as const;

test("adapter registration exposes the complete live surface", () => {
	const api = captureAdapter();

	assert.deepEqual([...api.commands.keys()].sort(), [
		"herder-attach",
		"herder-cleanup",
		"herder-dashboard",
		"herder-fire",
		"herder-grill",
		"herder-improve",
		"herder-plans",
		"herder-reset",
		"herder-resume",
		"herder-revise",
		"herder-simplify",
		"herder-status",
		"herder-stop",
		"herder-validate",
	].sort());
	assert.deepEqual(api.tools.map((tool) => tool.name).sort(), [
		"herder_integration_repair",
		"herder_plan",
		"herder_reignite",
		"herder_verification",
	].sort());
	assert.deepEqual([...api.handlers.keys()].sort(), ["agent_settled", "session_shutdown", "session_start"]);
	assert.deepEqual([...api.renderers].sort(), [
		"herder-cleanup-v2",
		"herder-worker-input-v1",
		"herder-worker-output-v1",
	].sort());

	for (const tool of api.tools) {
		const schema = record(tool.parameters);
		const required = schema.required;
		assert.ok(Array.isArray(required));
		assert.ok(required.includes("planDirectory"));
		const properties = record(schema.properties);
		assert.equal(record(properties.planDirectory).type, "string");
	}
});

test("run tools enforce trust before repository work", async () => {
	const api = captureAdapter();
	const untrusted = context(false);
	const cases = [
		[
			"herder_integration_repair",
			runToolParameters.integration,
			"Trust this project before submitting an integration repair transition.",
		],
		[
			"herder_verification",
			runToolParameters.verification,
			"Trust this project before submitting Herder verification.",
		],
		[
			"herder_reignite",
			runToolParameters.reignite,
			"Trust this project before acknowledging a Herder reignite write.",
		],
	] as const;

	for (const [name, parameters, message] of cases) {
		await rejectsMessage(
			() => api.tool(name).execute("trust-gate", parameters, undefined, undefined, untrusted),
			message,
		);
	}
});

test("run-tool execution is cancelled after the captured session shuts down", async () => {
	const api = captureAdapter();
	await api.invoke("session_shutdown");

	await rejectsMessage(
		() => api.tool("herder_verification").execute(
			"shutdown-gate",
			runToolParameters.verification,
			undefined,
			undefined,
			context(true),
		),
		"Herder operation was cancelled because the Pi session changed or shut down.",
	);
});

test("planning tool returns its trust error before repository or manager work", async () => {
	const api = captureAdapter();
	const result = record(await api.tool("herder_plan").execute(
		"planning-trust-gate",
		{ operation: "status", planDirectory: "herder-plans" },
		undefined,
		undefined,
		context(false),
	));

	assert.equal(result.isError, true);
	const content = result.content;
	assert.ok(Array.isArray(content));
	assert.equal(record(content[0]).text, "Trust this project before using Herder plan operations.");
});
