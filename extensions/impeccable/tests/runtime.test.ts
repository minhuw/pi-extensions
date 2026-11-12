import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionUIContext,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import impeccableExtension from "../index.ts";
import { IMPECCABLE_TOOL_NAMES, SKILL_LOCATION_MESSAGE } from "../src/activation.ts";
import { delegate } from "../src/delegation.ts";
import { getSkillDir } from "../src/resources.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

isolateEngineEnvironment();

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function fixture(options: { subagents?: boolean; nested?: boolean; childImpeccable?: boolean; activateImpeccableTools?: boolean; loadResources?: boolean; sessionManager?: SessionManager; uiContext?: ExtensionUIContext; agentFrontmatter?: Record<string, string>; fallbackSubagent?: string; extraExtension?: (pi: ExtensionAPI) => void } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-impeccable-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const previousCwd = process.cwd();
	const restore = () => {
		if (!options.subagents) return;
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
	};
	let session: AgentSession | undefined;
	try {
		if (options.subagents) {
			process.env.PI_CODING_AGENT_DIR = directory;
			// Subagents prefers this override to its normal agent-directory default.
			process.env.PI_CODING_AGENT_SESSION_DIR = join(directory, "sessions");
			process.chdir(directory);
			await mkdir(join(directory, ".pi/agents"), { recursive: true });
			if (options.fallbackSubagent !== undefined) await writeFile(join(directory, ".pi/subagents.json"), JSON.stringify({ fallbackSubagent: options.fallbackSubagent }));
			for (const type of ["worker", "recon", ...(options.nested ? ["orchestrator"] : [])]) {
				await writeFile(join(directory, `.pi/agents/${type}.md`), `---\ndescription: Isolated faux ${type}\nmodel: impeccable-test/test\nextensions: true\nskills: ${options.loadResources ? "true" : "false"}\n${options.agentFrontmatter?.[type] ?? ""}---\nPerform the bounded supplied task.\n`);
			}
			if (options.nested || options.childImpeccable) {
				await mkdir(join(directory, ".pi/extensions"), { recursive: true });
				// Child sessions discover extensions afresh; parent inline factories
				// are not inherited. Load the actual adapter in this isolated project.
				await writeFile(join(directory, ".pi/extensions/impeccable.ts"), `export { default } from ${JSON.stringify(join(getSkillDir(), "../../index.ts"))};\n`);
			}
			await writeFile(join(directory, "page.html"), "<main>Supplied review evidence</main>\n");
		}
		const subagents = options.subagents ? (await import("../../subagents/src/index.ts")).default : undefined;
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ api: "impeccable-test-api", provider: "impeccable-test", models: [{ id: "test" }] });
		const promptsDir = join(getSkillDir(), "../../prompts");
		const promptFiles = options.loadResources
			? (await readdir(promptsDir)).filter((name) => name.endsWith(".md")).map((name) => join(promptsDir, name))
			: [];
		const resources = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: !options.loadResources,
			noThemes: true,
			noContextFiles: true,
			...(options.loadResources
				? {
						additionalSkillPaths: [join(getSkillDir(), "..")],
						additionalPromptTemplatePaths: promptFiles,
					}
				: {}),
			extensionFactories: [
				(pi) => {
					pi.registerProvider(faux.provider);
					impeccableExtension(pi);
				},
				...(subagents ? [subagents] : []),
				...(options.extraExtension ? [options.extraExtension] : []),
			],
		});
		await resources.reload();
		expect(resources.getExtensions().errors).toEqual([]);
		const settingsManager = options.activateImpeccableTools === false
			? SettingsManager.inMemory({ retry: { enabled: false } })
			: SettingsManager.inMemory({ defaultTools: [...IMPECCABLE_TOOL_NAMES], retry: { enabled: false } });
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			model: faux.getModel("test")!,
			resourceLoader: resources,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
			settingsManager,
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", uiContext: options.uiContext, onError: (error) => errors.push(error) });
		const current = session;
		return {
			session: current,
			faux,
			errors,
			async cleanup() {
				try {
					await current.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
					current.dispose();
				} finally {
					restore();
					await rm(directory, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		session?.dispose();
		restore();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

it.each([false, true])("isolates child session persistence from an ambient session-directory override, setup failure=%s", async (setupFailure) => {
	const ambientDirectory = await mkdtemp(join(tmpdir(), "pi-impeccable-ambient-sessions-"));
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousCwd = process.cwd();
	let fixtureDirectory = "";
	let h: Awaited<ReturnType<typeof fixture>> | undefined;
	try {
		process.env.PI_CODING_AGENT_SESSION_DIR = ambientDirectory;
		const creating = fixture({
			subagents: true,
			agentFrontmatter: {
				get worker(): string {
					fixtureDirectory = process.env.PI_CODING_AGENT_DIR!;
					if (setupFailure) throw new Error("Offline fixture setup failure");
					return "";
				},
			},
		});
		if (setupFailure) {
			await expect(creating).rejects.toThrow("Offline fixture setup failure");
		} else {
			h = await creating;
			expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(fixtureDirectory, "sessions"));
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("impeccable_delegate", { role: "documenter", task: "Inspect page.html and report actual evidence only.", artifactPaths: ["page.html"] })]),
				fauxAssistantMessage("Isolated child transcript evidence."),
				fauxAssistantMessage("Parent retained the isolated child result."),
			]);
			await h.session.prompt("Exercise persistent child session isolation.");
			expect(h.faux.state.callCount).toBe(3);
			const sessionDirectory = join(fixtureDirectory, "sessions");
			const transcripts = (await readdir(sessionDirectory, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
			expect(transcripts).toHaveLength(1);
			const transcript = await readFile(join(sessionDirectory, transcripts[0]!), "utf8");
			expect(transcript).toContain("# Impeccable Documenter");
			expect(transcript).toContain("Isolated child transcript evidence.");
			expect(h.errors).toEqual([]);
			await h.cleanup();
			h = undefined;
		}
		expect(await readdir(ambientDirectory)).toEqual([]);
		expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(ambientDirectory);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(previousAgentDir);
		expect(process.cwd()).toBe(previousCwd);
		expect(fixtureDirectory).not.toBe("");
		await expect(readdir(fixtureDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		try { await h?.cleanup(); }
		finally {
			if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
			await rm(ambientDirectory, { recursive: true, force: true });
		}
	}
});

const fakeEngine = (marker: string) => `#!/bin/sh
echo "engine context ok"
echo "SKILL_DIR:$IMPECCABLE_SKILL_DIR"
echo "SELF:$IMPECCABLE_SELF"
echo "PWD:$(pwd)"
echo "${marker}"
exit 0
`;

it.skipIf(process.platform === "win32")(
	"invokes impeccable_run through a real session with a faux provider",
	async () => {
		const previous = process.env.IMPECCABLE_BIN;
		const directory = await mkdtemp(join(tmpdir(), "pi-impeccable-bin-"));
		try {
			const binary = join(directory, "fake-engine");
			const marker = `marker-${Date.now()}`;
			await writeFile(binary, fakeEngine(marker), { mode: 0o755 });
			await chmod(binary, 0o755);
			process.env.IMPECCABLE_BIN = binary;

			const h = await fixture();
			try {
				const settled = deferred();
				h.session.subscribe((event) => {
					if (event.type === "agent_settled") settled.resolve();
				});
				h.faux.setResponses([
					fauxAssistantMessage([fauxToolCall("impeccable_run", { argv: ["context"] })]),
					fauxAssistantMessage("engine ran"),
				]);
				await h.session.prompt("run the impeccable engine once");
				await settled.promise;

				expect(h.faux.state.callCount).toBe(2);
				expect(h.errors).toEqual([]);

				const results = h.session.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "message" && "role" in entry.message && entry.message.role === "toolResult"
							? [entry.message]
							: [],
					);
				const message: ToolResultMessage | undefined = results.find((candidate) => candidate.toolName === "impeccable_run");
				expect(message).toBeDefined();
				expect(message?.isError).toBe(false);
				const text = (message?.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
				expect(text).toContain("engine context ok");
				expect(text).toContain(`SKILL_DIR:${getSkillDir()}`);
				expect(text).toContain(marker);
				expect(text).toContain(`PWD:${await realpath(h.session.sessionManager.getCwd())}`);
			} finally {
				await h.cleanup();
			}
		} finally {
			if (previous === undefined) delete process.env.IMPECCABLE_BIN;
			else process.env.IMPECCABLE_BIN = previous;
			await rm(directory, { recursive: true, force: true });
		}
	},
	10_000,
);

it("executes structured question dialogs on a real Pi faux-provider turn with actual partial responses", async () => {
	const dialogs: string[] = [];
	const ui = {
		select: async (title: string, choices: string[]) => {
			dialogs.push(title);
			return choices.find((choice) => choice === "No");
		},
		input: async (title: string) => { dialogs.push(title); return undefined; },
	} as unknown as ExtensionUIContext;
	const h = await fixture({ uiContext: ui });
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_question", { questions: [
				{ id: "approve", question: "Approve this concept?", choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
				{ id: "purpose", question: "What is missing?" },
			] })]),
			fauxAssistantMessage("The concept is not approved; the second question is unanswered."),
		]);
		await h.session.prompt("Ask the related design questions.");
		expect(dialogs).toEqual(["Approve this concept?", "What is missing?"]);
		const results = h.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(results.find((result) => result.toolName === "impeccable_question")?.details).toMatchObject({ status: "dismissed", answers: [{ id: "approve", choiceId: "no", value: "No" }], pending: [{ id: "purpose" }] });
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it("returns a chat fallback from a real Pi tool call without dialog UI", async () => {
	const h = await fixture();
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_question", { questions: [{ id: "purpose", question: "What should this surface do?" }] })]),
			fauxAssistantMessage("What should this surface do?"),
		]);
		await h.session.prompt("Ask a material question without UI.");
		const results = h.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(results[0]?.details).toMatchObject({ status: "unavailable", answers: [], pending: [{ id: "purpose" }] });
		expect(h.faux.state.callCount).toBe(2);
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it("dispatches a complete adapted role to a real Subagents child on the faux provider", async () => {
	const h = await fixture({ subagents: true });
	let childContext = "";
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_delegate", {
				role: "documenter", task: "Inspect only the supplied artifact. Report No changes with checked paths; do not write missing product facts.", artifactPaths: ["page.html"], contextPaths: ["PRODUCT.md"],
			})]),
			(context) => {
				childContext = JSON.stringify(context);
				return fauxAssistantMessage("No changes. Checked page.html and PRODUCT.md; source evidence unavailable, no design facts invented.");
			},
			fauxAssistantMessage("The actual child reported no changes and missing evidence."),
		]);
		await h.session.prompt("PARENT-PRIVATE-MARKER: run the bounded documenter task through the adapter.");
		expect(h.faux.state.callCount).toBe(3);
		expect(childContext).toContain("# Impeccable Documenter");
		expect(childContext).toContain("## Output Contract");
		expect(childContext).toContain("Inspect only the supplied artifact");
		expect(childContext).not.toContain("PARENT-PRIVATE-MARKER");
		const results = h.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		const delegated = results.find((result) => result.toolName === "impeccable_delegate");
		expect(delegated?.isError).toBe(false);
		expect(delegated?.details).toMatchObject({ status: "completed", agent: { status: "completed", subagentType: "worker", agentId: expect.any(String), turnCount: 1 } });
		expect(JSON.stringify(delegated)).toContain("No changes. Checked page.html");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it.each([true, false])("stops a real manual-edit child before an attempted turn-13 edit, terminal answer on turn 12=%s", async (finishesOnBudget) => {
	let extraChildRequest = false;
	let delegated: Awaited<ReturnType<typeof delegate>> | undefined;
	const turns: number[] = [];
	const done = '{"status":"done","appliedEntryIds":["copy"],"failed":[],"files":["page.html"],"notes":[]}';
	const h = await fixture({
		subagents: true,
		extraExtension: (pi) => pi.registerTool({
			name: "probe_boundary", label: "Probe Boundary", description: "Offline turn-boundary regression", parameters: Type.Object({}),
			async execute(_id, _params, signal, _update, ctx) {
				delegated = await delegate({
					role: "manual-edit-applier",
					task: `Apply only event offline-copy, entry copy, to page.html in ${ctx.cwd}. Replace literal Supplied review evidence with Updated copy; retain the main element. Parent owns protocol replies; return canonical JSON only.`,
					artifactPaths: ["page.html"],
				}, ctx, signal, (partial) => {
					const count = (partial.details as { turnCount?: number } | undefined)?.turnCount;
					if (count !== undefined) turns.push(count);
				});
				return delegated;
			},
		}),
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe_boundary", {})]),
			...Array.from({ length: 10 }, () => fauxAssistantMessage([fauxToolCall("read", { path: "page.html" })])),
			fauxAssistantMessage([fauxToolCall("edit", { path: "page.html", edits: [{ oldText: "Supplied review evidence", newText: "Updated copy" }] })]),
			finishesOnBudget ? fauxAssistantMessage(done) : fauxAssistantMessage([fauxToolCall("read", { path: "page.html" })]),
			(context) => {
				if (JSON.stringify(context).includes("PARENT-BOUNDARY-PROBE")) return fauxAssistantMessage("Parent retained the actual child outcome.");
				extraChildRequest = true;
				return fauxAssistantMessage([fauxToolCall("edit", { path: "page.html", edits: [{ oldText: "Updated copy", newText: "FORBIDDEN TURN-13 EDIT" }] })]);
			},
			fauxAssistantMessage(done),
			fauxAssistantMessage("Parent retained the actual child outcome."),
		]);
		await h.session.prompt("PARENT-BOUNDARY-PROBE: probe the manual-edit turn boundary.");
		expect(extraChildRequest).toBe(false);
		expect(h.faux.state.callCount).toBe(14);
		expect(turns).toContain(12);
		// Cancellation may add an aborted assistant turn without a provider call.
		expect(Math.max(...turns)).toBeLessThanOrEqual(13);
		expect(delegated?.details).toMatchObject({
			status: "cancelled", reason: "turn-boundary-reached", inlineSubstitutionAllowed: false,
			agent: { subagentType: "worker" },
		});
		if (finishesOnBudget) expect(JSON.stringify(delegated?.content)).toContain(JSON.stringify(done).slice(1, -1));
		expect(await readFile(join(h.session.sessionManager.getCwd(), "page.html"), "utf8")).toBe("<main>Updated copy</main>\n");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it("runs a real worker with a compatible configured soft limit without premature rejection", async () => {
	let delegated: Awaited<ReturnType<typeof delegate>> | undefined;
	const h = await fixture({
		subagents: true,
		agentFrontmatter: { worker: "max_turns: 12\n" },
		extraExtension: (pi) => pi.registerTool({
			name: "probe_configured_limit", label: "Probe Configured Limit", description: "Offline configured limit regression", parameters: Type.Object({}),
			async execute(_id, _params, signal, _update, ctx) {
				delegated = await delegate({ role: "manual-edit-applier", task: "Apply only the leased copy edit in page.html, returning canonical JSON.", artifactPaths: ["page.html"] }, ctx, signal);
				return delegated;
			},
		}),
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe_configured_limit", {})]),
			fauxAssistantMessage("Actual child completed within the configured limit."),
			fauxAssistantMessage("Parent retained the completed task."),
		]);
		await h.session.prompt("Probe the authoritative configured worker limit.");
		expect(h.faux.state.callCount).toBe(3);
		expect(delegated?.details).toMatchObject({ status: "completed", policyConflicts: [], agent: { maxTurns: 12, turnCount: 1 } });
		expect(JSON.stringify(delegated)).toContain("Actual child completed");
		expect(await readFile(join(h.session.sessionManager.getCwd(), "page.html"), "utf8")).toBe("<main>Supplied review evidence</main>\n");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it.each(["soft-wrap", "terminal-error", "type-substitution"] as const)("preserves real child edits without replay after %s", async (scenario) => {
	let startedChildren = 0;
	let agentCalls = 0;
	let rawOutcome: { details?: unknown; content: unknown } | undefined;
	let wrapInstructionObserved = false;
	const done = '{"status":"done","appliedEntryIds":["copy"],"failed":[],"files":["page.html"],"notes":[]}';
	const partial = "Edited page.html; verification incomplete.";
	const h = await fixture({
		subagents: true,
		agentFrontmatter: { worker: "max_turns: 1\n", ...(scenario === "type-substitution" ? { recon: "enabled: false\n" } : {}) },
		extraExtension: (pi) => {
			pi.events.on("subagents:telemetry", (event) => { if ((event as { phase: string }).phase === "started") startedChildren++; });
			pi.on("tool_call", (event) => { if (event.toolName === "Agent") agentCalls++; });
			pi.on("tool_result", (event) => { if (event.toolName === "Agent") rawOutcome = event; });
		},
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_delegate", {
				role: scenario === "type-substitution" ? "finish-reviewer" : "manual-edit-applier",
				task: "Leased event offline-copy, entry copy: replace literal Supplied review evidence with Updated copy in page.html, preserving the main element. Return canonical JSON with actual files and limitations; parent owns protocol replies.",
				artifactPaths: ["page.html"],
			})]),
			// The substituted worker deliberately writes even for a reviewer packet:
			// this tests preservation of actual work, not model role compliance.
			fauxAssistantMessage([fauxToolCall("edit", { path: "page.html", edits: [{ oldText: "Supplied review evidence", newText: "Updated copy" }] })]),
			async (context, options) => {
				expect(options?.signal?.aborted).toBe(false);
				expect(await readFile(join(h.session.sessionManager.getCwd(), "page.html"), "utf8")).toBe("<main>Updated copy</main>\n");
				const edit = context.messages.find((message) => message.role === "toolResult" && message.toolName === "edit");
				expect(edit).toMatchObject({ toolName: "edit", isError: false });
				wrapInstructionObserved = JSON.stringify(context).includes("You have reached your turn limit. Wrap up immediately");
				return scenario === "terminal-error"
					? fauxAssistantMessage(partial, { stopReason: "error", errorMessage: "Offline fixture fatal validation" })
					: fauxAssistantMessage(done);
			},
			(context) => {
				// Exactly one parent continuation, with the adapter's real outcome.
				expect(JSON.stringify(context)).toContain("inspect the actual output and changed artifacts");
				return fauxAssistantMessage("Parent retained actual artifacts for assessment; no inline replay authorized.");
			},
		]);
		await h.session.prompt("Exercise the native soft wrap and retain actual outcome; do not repeat edits.");
		expect(wrapInstructionObserved).toBe(true);
		expect(h.faux.state.callCount).toBe(4);
		expect(h.faux.getPendingResponseCount()).toBe(0);
		expect(startedChildren).toBe(1);
		expect(agentCalls).toBe(1);
		expect(rawOutcome?.details).toMatchObject({ status: scenario === "terminal-error" ? "error" : "steered", subagentType: "worker", maxTurns: 1, turnCount: 2, toolUses: 1 });
		const results = h.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(results).toHaveLength(1);
		const result = results[0]!;
		expect(result.toolName).toBe("impeccable_delegate");
		expect(result.isError).toBe(scenario !== "soft-wrap");
		expect(result.details).toMatchObject({
			status: scenario === "soft-wrap" ? "wrapped-up" : "partial",
			childTerminated: true, inlineSubstitutionAllowed: false, evidenceAssessmentRequired: true,
			reason: scenario === "soft-wrap" ? "soft-limit-wrap-up" : scenario === "terminal-error" ? "agent-error" : "policy-conflict",
			agent: rawOutcome?.details,
			policyConflicts: scenario === "type-substitution" ? ["agent type substituted: worker (requested recon)"] : [],
		});
		expect(result.content.slice(1)).toEqual(rawOutcome?.content);
		const output = result.content.map((part) => "text" in part ? part.text : "").join("\n");
		expect(output).toContain(scenario === "terminal-error" ? partial : done);
		if (scenario === "terminal-error") expect(output).toContain("Offline fixture fatal validation");
		expect(output).toContain("Do not substitute the full role inline or replay already-applied work");
		expect(output).toContain("only the remaining work after inspection");
		expect(output).not.toContain("Follow ");
		expect(result.details).not.toHaveProperty("fallbackPath");
		expect(await readFile(join(h.session.sessionManager.getCwd(), "page.html"), "utf8")).toBe("<main>Updated copy</main>\n");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it.each([undefined, "none"])("returns the upstream fallback from a real disabled-worker Agent without creating a child, fallback=%s", async (fallbackSubagent) => {
	let startedChildren = 0;
	let rawRefusal: { details?: unknown; content: unknown } | undefined;
	const h = await fixture({
		subagents: true, fallbackSubagent,
		agentFrontmatter: { worker: "enabled: false\n" },
		extraExtension: (pi) => {
			pi.events.on("subagents:telemetry", (event) => { if ((event as { phase: string }).phase === "started") startedChildren++; });
			pi.on("tool_result", (event) => { if (event.toolName === "Agent") rawRefusal = event; });
		},
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("impeccable_delegate", { role: "documenter", task: "Document only actual evidence in page.html.", artifactPaths: ["page.html"] })]),
			fauxAssistantMessage("Worker unavailable; disclose the degraded documentation path."),
		]);
		await h.session.prompt("Use the configured documenter worker if available.");
		expect(h.faux.state.callCount).toBe(2);
		expect(startedChildren).toBe(0);
		expect(rawRefusal).toBeDefined();
		expect(rawRefusal?.details).toBeUndefined();
		const refusal = `Unknown or disabled agent type: "worker". ${fallbackSubagent === "none" ? "" : 'Default fallback "worker" is unknown or disabled. '}Available: recon.`;
		expect(rawRefusal?.content).toEqual([{ type: "text", text: refusal }]);
		const results = h.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		const result = results.find((entry) => entry.toolName === "impeccable_delegate");
		expect(result?.details).toMatchObject({ status: "unavailable", inlineSubstitutionAllowed: true, fallbackPath: join(getSkillDir(), "reference/degraded/documenter.md") });
		expect(JSON.stringify(result?.content)).toContain(refusal.replaceAll('"', '\\"'));
		expect(await readFile(join(h.session.sessionManager.getCwd(), "page.html"), "utf8")).toBe("<main>Supplied review evidence</main>\n");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it.each([false, true])("hands off from the actual nested Agent before dispatch, configured background worker=%s", async (background) => {
	let nestedResult: Awaited<ReturnType<typeof delegate>> | undefined;
	const h = await fixture({
		subagents: true, nested: true,
		agentFrontmatter: { orchestrator: "allowed_subagents: worker\n", worker: `run_in_background: ${background}\n` },
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("Agent", { subagent_type: "orchestrator", prompt: "Invoke impeccable_delegate and return its exact limitation to the main session.", description: "Probe nested adapter", inherit_context: false, run_in_background: false })]),
			fauxAssistantMessage([fauxToolCall("impeccable_delegate", { role: "documenter", task: "Inspect page.html and document only actual evidence.", artifactPaths: ["page.html"] })]),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "impeccable_delegate");
				nestedResult = result as unknown as Awaited<ReturnType<typeof delegate>>;
				return fauxAssistantMessage("Nested adapter returned the complete role handoff without starting a writer.");
			},
			fauxAssistantMessage("Main session received the handoff; no duplicate work started."),
		]);
		await h.session.prompt("Probe delegation inside an opted-in child.");
		expect(h.faux.state.callCount).toBe(4);
		expect(nestedResult).toBeDefined();
		expect(nestedResult?.details).toMatchObject({ status: "handoff", reason: "nested-agent-contract-unsupported", inlineSubstitutionAllowed: false, handoff: { tool: "Agent", arguments: { subagent_type: "worker", max_turns: 30 } } });
		expect(JSON.stringify(nestedResult)).toContain("# Impeccable Documenter");
		expect(JSON.stringify(nestedResult)).toContain("was not dispatched");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it("hands off an actual configured background writer and retrieves its result before dependent work", async () => {
	let active: Awaited<ReturnType<typeof delegate>> | undefined;
	let terminalText = "";
	const childStarted = deferred();
	const releaseChild = deferred();
	const h = await fixture({
		subagents: true,
		agentFrontmatter: { worker: "run_in_background: true\n" },
		extraExtension: (pi) => pi.registerTool({
			name: "probe_background", label: "Probe Background", description: "Offline lifecycle regression", parameters: Type.Object({}),
			async execute(_id, _params, _signal, _update, ctx) {
				const caller = new AbortController();
				active = await delegate({ role: "documenter", task: "Inspect page.html and report actual evidence only.", artifactPaths: ["page.html"] }, ctx, caller.signal);
				await childStarted.promise;
				caller.abort();
				expect(active.details).toMatchObject({ status: "active", agentId: expect.any(String), callerCancellationStopsChild: false, inlineSubstitutionAllowed: false });
				releaseChild.resolve();
				const handoff = (active.details as Record<string, unknown>).handoff as { tool: string; arguments: unknown };
				const terminal = await ctx.executeTool(handoff.tool, handoff.arguments);
				terminalText = terminal.result.content.map((part) => "text" in part ? part.text : "").join("\n");
				return { content: [{ type: "text", text: "Management handoff retrieved the real terminal result." }], details: {} };
			},
		}),
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe_background", {})]),
			async () => {
				childStarted.resolve();
				await releaseChild.promise;
				return fauxAssistantMessage("Actual detached documenter settled without inline substitution.");
			},
			fauxAssistantMessage("The writer settled before dependent work."),
		]);
		await h.session.prompt("Probe the configured background override.");
		expect(h.faux.state.callCount).toBe(3);
		expect(terminalText).toContain("Status: completed");
		expect(terminalText).toContain("Actual detached documenter settled");
		expect(h.errors).toEqual([]);
	} finally { releaseChild.resolve(); await h.cleanup(); }
});

it("hands off finish continuations because the actual unlimited Agent resume path emits no progress even beyond 30 turns", async () => {
	let continuation: Awaited<ReturnType<typeof delegate>> | undefined;
	let resumedDetails: unknown;
	let resumeUpdates = 0;
	const h = await fixture({
		subagents: true,
		agentFrontmatter: { recon: "max_turns: 0\n" },
		extraExtension: (pi) => pi.registerTool({
			name: "probe_resume", label: "Probe Resume", description: "Offline continuation regression", parameters: Type.Object({}),
			async execute(_id, _params, signal, _update, ctx) {
				const request = { role: "finish-reviewer" as const, task: "Review supplied page.html only, returning actual evidence.", artifactPaths: ["page.html"] };
				const initial = await delegate(request, ctx, signal);
				expect(initial.details.status).toBe("completed");
				const resume = ((initial.details as Record<string, unknown>).agent as { agentId: string }).agentId;
				continuation = await delegate({ ...request, resume }, ctx, signal);
				expect(continuation.details).toMatchObject({ status: "handoff", reason: "continuation-limit-unenforceable" });
				// Exercise the real runtime limitation independently of the adapter:
				// this explicit offline probe is allowed to run 31 harmless read-only turns.
				const raw = await ctx.executeTool("Agent", { subagent_type: "recon", description: "Probe unlimited resume", prompt: "Recapture review evidence and report a verdict.", resume, max_turns: 30, run_in_background: false }, { signal, onUpdate: () => { resumeUpdates++; } });
				resumedDetails = raw.result.details;
				return { content: [{ type: "text", text: "Observed actual Agent resume progress behavior." }], details: {} };
			},
		}),
	});
	try {
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe_resume", {})]),
			fauxAssistantMessage("Initial supplied-evidence review completed."),
			...Array.from({ length: 30 }, () => fauxAssistantMessage([fauxToolCall("read", { path: "page.html" })])),
			fauxAssistantMessage("Actual 31-turn resume verdict."),
			fauxAssistantMessage("The adapter returned a handoff; the separate runtime probe exceeded the role ceiling."),
		]);
		await h.session.prompt("Probe the real foreground resume with an unlimited configured reviewer.");
		expect(h.faux.state.callCount).toBe(34);
		expect(resumedDetails).toMatchObject({ status: "completed", subagentType: "recon", turnCount: 31 });
		expect(resumeUpdates).toBe(0);
		expect(continuation?.details.status).toBe("handoff");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
});

it("keeps impeccable_* tools, rules, and <available_skills> completely inactive on ordinary UI prompts", async () => {
	const h = await fixture({ activateImpeccableTools: false, loadResources: true });
	try {
		const allToolNames = h.session.getAllTools().map((tool) => tool.name);
		for (const name of IMPECCABLE_TOOL_NAMES) expect(allToolNames).toContain(name);
		expect(h.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		const observedTools: string[][] = [];
		const observedPrompts: string[] = [];
		h.faux.setResponses([
			(context) => {
				observedTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				observedPrompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("Designed a clean settings dashboard.");
			},
			(context) => {
				observedTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				observedPrompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("Checked the URL and design-system file.");
			},
		]);

		await h.session.prompt("Design a settings dashboard and polish the layout");
		await h.session.prompt("Inspect https://example.com/design and src/design-system/layout.tsx");

		expect(observedTools).toEqual([
			["read", "bash", "edit", "write"],
			["read", "bash", "edit", "write"],
		]);
		for (const sys of observedPrompts) {
			for (const name of IMPECCABLE_TOOL_NAMES) expect(sys).not.toContain(name);
			expect(sys).not.toContain("Use impeccable_run for other Impeccable engine verbs");
			expect(sys).not.toContain("<name>impeccable</name>");
			expect(sys).not.toContain(getSkillDir());
		}
		expect(h.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(
			h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === SKILL_LOCATION_MESSAGE),
		).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally {
		await h.cleanup();
	}
});

it.each([
	{ label: "plain mention", input: "Use impeccable to critique page.html", expectSkillLocation: true },
	{ label: "/impeccable", input: "/impeccable critique page.html", expectSkillLocation: true },
	{ label: "/design-audit", input: "/design-audit page.html", expectSkillLocation: true },
	{ label: "/i alias", input: "/i critique page.html", expectSkillLocation: true },
	{ label: "/skill:impeccable", input: "/skill:impeccable critique page.html", expectSkillLocation: false },
	{ label: "pinned prompt", input: "/pinned-craft page.html", expectSkillLocation: true, pinShortcut: true },
])("activates all 5 impeccable_* tools on Turn 1 for $label and deduplicates skill-location context", async ({ input, expectSkillLocation, pinShortcut }) => {
	const h = await fixture({ activateImpeccableTools: false, loadResources: true });
	try {
		if (pinShortcut) {
			const promptsDir = join(h.session.sessionManager.getCwd(), ".pi/prompts");
			await mkdir(promptsDir, { recursive: true });
			await writeFile(
				join(promptsDir, "pinned-craft.md"),
				"---\ndescription: \"Pinned shortcut\"\n---\n\n<!-- pi-impeccable-owned-prompt:v1 -->\nFollow craft on $ARGUMENTS\n",
			);
			await h.session.reload();
		}
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(h.session.getActiveToolNames()).not.toContain(name);
		}

		let turn1Tools: string[] = [];
		let turn1Prompt = "";
		let turn1RawContext = "";
		h.faux.setResponses([
			(context) => {
				turn1Tools = getCurrentTools(context.messages).map((tool) => tool.name);
				turn1Prompt = getCurrentSystemPrompt(context.messages);
				turn1RawContext = JSON.stringify(context.messages);
				return fauxAssistantMessage("Handled first Impeccable request.");
			},
			fauxAssistantMessage("Handled follow-up Impeccable request."),
			fauxAssistantMessage("Handled post-compaction Impeccable request."),
		]);

		await h.session.prompt(input);

		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(turn1Tools).toContain(name);
			expect(h.session.getActiveToolNames()).toContain(name);
		}
		expect(turn1Prompt).toContain("impeccable_run");
		expect(turn1Prompt).toContain("Use impeccable_run for other Impeccable engine verbs");
		expect(turn1RawContext).toContain(getSkillDir());

		const skillLocationEntries = () =>
			h.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === SKILL_LOCATION_MESSAGE);

		if (!expectSkillLocation) {
			expect(skillLocationEntries()).toHaveLength(0);
		} else {
			expect(skillLocationEntries()).toHaveLength(1);
			expect(skillLocationEntries()[0]).toMatchObject({
				display: false,
				content: expect.stringContaining(getSkillDir()),
			});

			await h.session.prompt("Run impeccable doctor next");
			expect(skillLocationEntries()).toHaveLength(1);

			const firstId = h.session.sessionManager.getBranch()[0]!.id;
			h.session.sessionManager.appendCompaction("Compacted earlier context", firstId, 100);
			await h.session.prompt("Run impeccable context after compaction");
			expect(skillLocationEntries()).toHaveLength(2);
		}
		expect(h.errors).toEqual([]);
	} finally {
		await h.cleanup();
	}
});

it("restores impeccable_* tools on session_start/session_tree from branch state and activates on /impeccable-live", async () => {
	const seedManager = SessionManager.inMemory("/tmp");
	seedManager.appendCustomMessageEntry(SKILL_LOCATION_MESSAGE, `Impeccable skill directory (<skill-base-dir>): ${getSkillDir()}`, false);
	const resumed = await fixture({ activateImpeccableTools: false, sessionManager: seedManager });
	try {
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(resumed.session.getActiveToolNames()).toContain(name);
		}
		expect(resumed.errors).toEqual([]);
	} finally {
		await resumed.cleanup();
	}

	const tree = await fixture({ activateImpeccableTools: false });
	try {
		tree.faux.setResponses([
			fauxAssistantMessage("Ordinary response."),
			fauxAssistantMessage("Impeccable response."),
		]);
		await tree.session.prompt("Fix button alignment");
		const ordinaryAssistantId = tree.session.sessionManager.getLeafId()!;
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(tree.session.getActiveToolNames()).not.toContain(name);
		}
		await tree.session.prompt("Use impeccable to critique page.html");
		const impeccableLeafId = tree.session.sessionManager.getLeafId()!;
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(tree.session.getActiveToolNames()).toContain(name);
		}
		await tree.session.navigateTree(ordinaryAssistantId);
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(tree.session.getActiveToolNames()).not.toContain(name);
		}
		await tree.session.navigateTree(impeccableLeafId);
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(tree.session.getActiveToolNames()).toContain(name);
		}
		expect(tree.errors).toEqual([]);
	} finally {
		await tree.cleanup();
	}

	const live = await fixture({ activateImpeccableTools: false });
	try {
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(live.session.getActiveToolNames()).not.toContain(name);
		}
		await live.session.prompt("/impeccable-live status");
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(live.session.getActiveToolNames()).toContain(name);
		}
		expect(live.errors).toEqual([]);
	} finally {
		await live.cleanup();
	}
});

it("keeps ordinary worker subagents clean while activating impeccable_* in delegated worker subagents on Turn 1", async () => {
	const h = await fixture({
		subagents: true,
		childImpeccable: true,
		activateImpeccableTools: false,
		loadResources: true,
	});
	try {
		const cwd = h.session.sessionManager.getCwd();
		await mkdir(join(cwd, ".pi/skills"), { recursive: true });
		await symlink(getSkillDir(), join(cwd, ".pi/skills/impeccable"), "dir");
		await writeFile(join(cwd, "helper.ts"), "export const x = 1;\n");
		let preActivationWorkerTools: string[] = [];
		let preActivationWorkerPrompt = "";
		let delegatedWorkerTools: string[] = [];
		let delegatedWorkerPrompt = "";
		let delegatedCapabilitiesResult: ToolResultMessage | undefined;
		let postActivationWorkerTools: string[] = [];

		h.faux.setResponses([
			// 1. Ordinary parent prompt spawns an ordinary worker on "Update helper.ts"
			fauxAssistantMessage([
				fauxToolCall("Agent", {
					subagent_type: "worker",
					description: "Update helper",
					prompt: "Update helper.ts and polish its formatting.",
					inherit_context: false,
					run_in_background: false,
				}),
			]),
			(context) => {
				preActivationWorkerTools = getCurrentTools(context.messages).map((tool) => tool.name);
				preActivationWorkerPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage([fauxToolCall("read", { path: "helper.ts" })]);
			},
			fauxAssistantMessage("Checked helper.ts."),
			fauxAssistantMessage("Ordinary worker finished."),

			// 2. Explicit Impeccable mention in parent activates impeccable_delegate, which spawns a worker for role "documenter"
			fauxAssistantMessage([
				fauxToolCall("impeccable_delegate", {
					role: "documenter",
					task: "Inspect page.html and report No changes with checked paths.",
					artifactPaths: ["page.html"],
				}),
			]),
			(context) => {
				delegatedWorkerTools = getCurrentTools(context.messages).map((tool) => tool.name);
				delegatedWorkerPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage([fauxToolCall("impeccable_capabilities", {})]);
			},
			(context) => {
				delegatedCapabilitiesResult = context.messages.find(
					(msg): msg is ToolResultMessage => msg.role === "toolResult" && msg.toolName === "impeccable_capabilities",
				);
				return fauxAssistantMessage("No changes. Checked page.html.");
			},
			fauxAssistantMessage("Delegated documenter finished."),

			// 3. Even after parent activated Impeccable, an ordinary worker spawned on "Update helper.ts" stays clean
			fauxAssistantMessage([
				fauxToolCall("Agent", {
					subagent_type: "worker",
					description: "Second helper check",
					prompt: "Update helper.ts",
					inherit_context: false,
					run_in_background: false,
				}),
			]),
			(context) => {
				postActivationWorkerTools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage([fauxToolCall("read", { path: "helper.ts" })]);
			},
			fauxAssistantMessage("Checked helper.ts again."),
			fauxAssistantMessage("Second ordinary worker finished."),
		]);

		await h.session.prompt("Run a worker to check helper.ts");
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(preActivationWorkerTools).not.toContain(name);
			expect(preActivationWorkerPrompt).not.toContain(name);
			expect(h.session.getActiveToolNames()).not.toContain(name);
		}
		expect(preActivationWorkerPrompt).not.toContain("<name>impeccable</name>");
		expect(preActivationWorkerTools).toContain("read");

		await h.session.prompt("Use impeccable to document page.html");
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(h.session.getActiveToolNames()).toContain(name);
			expect(delegatedWorkerTools).toContain(name);
		}
		expect(delegatedCapabilitiesResult?.isError).toBeFalsy();
		expect(delegatedWorkerPrompt).not.toContain("<name>impeccable</name>");

		await h.session.prompt("Run another worker on helper.ts");
		for (const name of IMPECCABLE_TOOL_NAMES) {
			expect(postActivationWorkerTools).not.toContain(name);
		}
		expect(h.errors).toEqual([]);
	} finally {
		await h.cleanup();
	}
});
