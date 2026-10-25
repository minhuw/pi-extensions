import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { StepAgents, type ExternalAgent, type ExternalAgentRegistry } from "../../src/adapter/external-agents.ts";
import { createPiAgentRunner } from "../../src/agents/session.ts";
import { withRun } from "../steps/harness.ts";

describe("live step sessions", () => {
	it("a faux-provider step is published with its live session, then finished without it", () => withRun(async (h) => {
		const dir = mkdtempSync(join(tmpdir(), "herder-live-"));
		try {
			mkdirSync(join(dir, "agent"));
			const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
			const faux = fauxProvider({ api: "herder-faux-api", provider: "herder-faux", models: [{ id: "main", reasoning: true }] });
			runtime.registerNativeProvider(faux.provider);
			const runner = createPiAgentRunner({
				modelRuntime: runtime, agentDir: join(dir, "agent"), inheritModel: () => faux.getModel("main"), inheritThinking: () => "low",
				settings: () => SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			});
			const registry: ExternalAgentRegistry = { agents: new Map(), listeners: new Set() };
			const agents = new StepAgents({ registry });
			let during: ExternalAgent[] = [];
			faux.setResponses([() => { during = [...registry.agents.values()]; return fauxAssistantMessage("looked"); }]);
			const result = await h.executor({ runner, onActivity: (activity) => agents.update(activity, { ownerSessionId: "s", runId: h.store.runId }) })
				.run("Look around.\nThen report.", { write: false, task: "T1", label: "survey" });
			expect(result).toMatchObject({ status: "ok", text: "looked" });
			expect(during).toHaveLength(1);
			expect(during[0]).toMatchObject({ source: "herder", name: "T1 · survey", description: "Look around.", model: "main", thinking: "low", status: "running" });
			expect(during[0]!.session).toBeInstanceOf(AgentSession);
			const [finished] = [...registry.agents.values()];
			expect(finished).toMatchObject({ id: during[0]!.id, status: "completed", completedAt: expect.any(Number) });
			expect(finished!.session).toBeUndefined();
			agents.clear();
			expect(registry.agents.size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}));
});
