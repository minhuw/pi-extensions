import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import extension from "../index.ts";
import { approvalKey, type State } from "../campaign.ts";
import { SNAPSHOT } from "../report.ts";

it("runs a main-session baseline through real Pi/bash, waits for host approval, then runs one measured iteration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-research-workflow-"));
	let session: AgentSession | undefined;
	try {
		await writeFile(join(directory, "measure.mjs"), "process.stdout.write('METRIC compile_ms=123\\n');\n");
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ api: "research-report-api", provider: "research-report", models: [{ id: "test" }] });
		const resources = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => { pi.registerProvider(faux.provider); extension(pi); }],
		});
		await resources.reload(); expect(resources.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources,
			sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"], retry: { enabled: false } }),
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error); } });
		const settled = () => new Promise<void>(resolve => {
			const unsubscribe = session!.subscribe(event => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
		});
		const snapshot = () => {
			const entry = session!.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === SNAPSHOT);
			return entry?.type === "custom" ? entry.data : undefined;
		};
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("autoresearch_baseline", {
				methodology: "Fixed compilation workload, three fresh process runs, median elapsed milliseconds. This fixture prints a deterministic measurement.",
				command: "node measure.mjs", files: ["measure.mjs"], repetitions: 3,
				metrics: [{ name: "compile_ms", label: "Compile", direction: "lower", unit: "ms" }],
			})]),
			fauxAssistantMessage("The baseline is 123 ms. Is this the right workload? Approve with /autoresearch approve."),
		]);
		let done = settled();
		await session.prompt("/autoresearch optimize compilation speed --max 1"); await done;
		expect(snapshot()).toMatchObject({ version: 2, campaign: {
			state: "awaiting_approval", iterations: 0, baseline: { samples: [{ compile_ms: 123 }, { compile_ms: 123 }, { compile_ms: 123 }], values: { compile_ms: 123 } },
		}, report: { provenance: "tool-measured" } });
		expect(faux.state.callCount).toBe(2);
		await session.prompt("/autoresearch status"); expect(faux.state.callCount).toBe(2);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("autoresearch_measure", {})]),
			fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "complete", message: "No further useful experiment in this fixture." })]),
			fauxAssistantMessage("Research complete."),
		]);
		done = settled(); await session.prompt("/autoresearch approve"); await done;
		expect(snapshot()).toMatchObject({ campaign: { state: "complete", iterations: 1 }, report: { phase: "complete", provenance: "tool-measured" } });
		expect(faux.state.callCount).toBe(5);
		expect(errors).toEqual([]);
		await session.prompt("/research-report clear");
		expect(snapshot()).toEqual({ version: 2, report: null, campaign: null });
	} finally {
		try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
		finally { await rm(directory, { recursive: true, force: true }); }
	}
}, 15_000);

it("lets a real setup pass report after its baseline, rejects pausing or completing it, and approves the same proposal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-research-setup-update-"));
	let session: AgentSession | undefined;
	try {
		await writeFile(join(directory, "measure.mjs"), "process.stdout.write('METRIC compile_ms=123\\n');\n");
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ api: "research-setup-api", provider: "research-setup", models: [{ id: "test" }] });
		const resources = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => { pi.registerProvider(faux.provider); extension(pi); }],
		});
		await resources.reload(); expect(resources.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources,
			sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"], retry: { enabled: false } }),
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", onError: error => { errors.push(error); } });
		const settled = () => new Promise<void>(resolve => {
			const unsubscribe = session!.subscribe(event => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
		});
		const snapshot = () => {
			const entry = session!.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === SNAPSHOT);
			return entry?.type === "custom" ? entry.data as State : undefined;
		};
		const updates = () => session!.sessionManager.getBranch().flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "autoresearch_update"
			? [{ isError: entry.message.isError, text: entry.message.content.map(part => part.type === "text" ? part.text : "").join("") }] : []);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("autoresearch_baseline", {
				methodology: "Fixed compilation workload, three fresh process runs, median elapsed milliseconds. This fixture prints a deterministic measurement.",
				command: "node measure.mjs", files: ["measure.mjs"], repetitions: 3,
				metrics: [{ name: "compile_ms", label: "Compile", direction: "lower", unit: "ms" }],
			})]),
			fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "checking", message: "Baseline recorded; explaining the methodology." })]),
			fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "complete", message: "Setup is done." })]),
			fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "paused", message: "Waiting for you." })]),
			fauxAssistantMessage("The baseline is 123 ms. Is this the right workload? Approve with /autoresearch approve."),
		]);
		let done = settled();
		await session.prompt("/autoresearch optimize compilation speed --max 1"); await done;
		expect(faux.state.callCount).toBe(5);
		const [progress, complete, paused] = updates();
		expect(progress).toMatchObject({ isError: false });
		expect(progress!.text).toContain("Baseline recorded; explaining the methodology.");
		for (const rejected of [complete, paused]) { expect(rejected?.isError).toBe(true); expect(rejected!.text).toContain("/autoresearch approve"); }
		const proposed = snapshot()!;
		expect(proposed).toMatchObject({ campaign: { state: "awaiting_approval", iterations: 0 }, report: { phase: "checking", message: "Baseline recorded; explaining the methodology.", provenance: "tool-measured" } });
		expect(proposed.campaign?.approved).toBeUndefined();
		const key = approvalKey(proposed);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("autoresearch_measure", {})]),
			fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "complete", message: "No further useful experiment in this fixture." })]),
			fauxAssistantMessage("Research complete."),
		]);
		done = settled(); await session.prompt("/autoresearch approve"); await done;
		expect(snapshot()).toMatchObject({ campaign: { state: "complete", iterations: 1, approved: key }, report: { phase: "complete" } });
		expect(updates().at(-1)).toMatchObject({ isError: false });
		expect(errors).toEqual([]);
	} finally {
		try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
		finally { await rm(directory, { recursive: true, force: true }); }
	}
}, 15_000);
