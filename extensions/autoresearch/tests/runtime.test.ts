import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import extension from "../index.ts";
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
