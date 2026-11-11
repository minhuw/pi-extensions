import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionUIContext, type KeybindingHints, type Theme } from "@earendil-works/pi-coding-agent";
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

it("keeps status displays out of the model context", async () => {
	const methodology = "Fixed compilation workload, three fresh process runs, median elapsed milliseconds. This fixture prints a deterministic measurement.";
	const count = (text: string, marker: string) => text.split(marker).length - 1;
	for (const mode of ["tui", "rpc"] as const) {
		const directory = await mkdtemp(join(tmpdir(), `pi-research-display-${mode}-`));
		let session: AgentSession | undefined;
		try {
			await writeFile(join(directory, "measure.mjs"), "process.stdout.write('METRIC compile_ms=123\\n');\n");
			const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
			const faux = fauxProvider({ api: `research-display-${mode}-api`, provider: `research-display-${mode}`, models: [{ id: "test" }] });
			const resources = new DefaultResourceLoader({
				cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); extension(pi); }],
			});
			await resources.reload(); expect(resources.getExtensions().errors).toEqual([]);
			({ session } = await createAgentSession({
				cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources,
				sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"], retry: { enabled: false } }),
			}));
			const notes: { message: string; type?: string }[] = []; const statuses = new Map<string, string | undefined>();
			const uiContext = {
				notify: (message: string, type?: string) => { notes.push({ message, type }); },
				setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
			} as unknown as ExtensionUIContext;
			const errors: unknown[] = [];
			await session.bindExtensions({ mode, uiContext, onError: error => { errors.push(error); } });
			const settled = () => new Promise<void>(resolve => {
				const unsubscribe = session!.subscribe(event => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
			});
			const contexts: string[] = [];
			const reply = (message: AssistantMessage): FauxResponseFactory => context => { contexts.push(JSON.stringify(context.messages)); return message; };
			faux.setResponses([
				reply(fauxAssistantMessage([fauxToolCall("autoresearch_baseline", {
					methodology, command: "node measure.mjs", files: ["measure.mjs"], repetitions: 3,
					metrics: [{ name: "compile_ms", label: "Compile", direction: "lower", unit: "ms" }],
				})])),
				reply(fauxAssistantMessage("The baseline is 123 ms. Approve with /autoresearch approve.")),
			]);
			let done = settled();
			await session.prompt("/autoresearch optimize compilation speed --max 1"); await done;
			expect(faux.state.callCount).toBe(2);
			const displays = () => session!.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === "autoresearch:display" ? [(entry.data as { text: string }).text] : []);
			await session.prompt("/autoresearch status"); await session.prompt("/research-report");
			expect(faux.state.callCount).toBe(2);
			const shown = mode === "tui" ? displays() : notes.filter(note => note.type === "info").map(note => note.message);
			expect(shown).toHaveLength(2);
			for (const text of shown) { expect(text).toContain(methodology); expect(text).toContain("State: awaiting_approval"); }
			if (mode === "tui") expect(notes).toEqual([]); else expect(displays()).toEqual([]);
			expect(statuses.get("autoresearch")).toContain("awaiting approval");
			faux.setResponses([reply(fauxAssistantMessage("It is 123 ms."))]);
			done = settled(); await session.prompt("What is the baseline?"); await done;
			expect(faux.state.callCount).toBe(3);
			const [, before, after] = contexts as [string, string, string];
			expect(after).toContain("What is the baseline?");
			expect(count(after, "State: awaiting_approval")).toBe(0);
			expect(count(after, methodology)).toBe(count(before, methodology));
			expect(after).not.toContain("autoresearch:display");
			expect(session.messages.some(message => message.role === "custom" && message.customType === "autoresearch:display")).toBe(false);
			expect(session.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "autoresearch:display")).toBe(false);
			expect(errors).toEqual([]);
		} finally {
			try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
			finally { await rm(directory, { recursive: true, force: true }); }
		}
	}
}, 30_000);

const DISPLAY = "autoresearch:display";
const METHODOLOGY = "Fixed compilation workload, three fresh process runs, median elapsed milliseconds. This fixture prints a deterministic measurement.";
const BASELINE = { methodology: METHODOLOGY, command: "node measure.mjs", files: ["measure.mjs"], repetitions: 3, metrics: [{ name: "compile_ms", label: "Compile", direction: "lower", unit: "ms" }] };

// A real Pi session on the faux provider: the UI records notifications and statuses, and each provider request records the messages it received.
async function displaySession(mode: "tui" | "rpc" | "print") {
	const directory = await mkdtemp(join(tmpdir(), `pi-research-shown-${mode}-`));
	let session: AgentSession | undefined;
	const cleanup = async () => {
		try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } }
		finally { await rm(directory, { recursive: true, force: true }); }
	};
	try {
		await writeFile(join(directory, "measure.mjs"), "process.stdout.write('METRIC compile_ms=123\\n');\n");
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ api: `research-shown-${mode}-api`, provider: `research-shown-${mode}`, models: [{ id: "test" }] });
		const resources = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => { pi.registerProvider(faux.provider); extension(pi); }],
		});
		await resources.reload(); expect(resources.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources,
			sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"], retry: { enabled: false } }),
		}));
		const s = session;
		const notes: { message: string; type?: string }[] = []; const statuses = new Map<string, string | undefined>(); const errors: unknown[] = []; const contexts: string[] = [];
		const uiContext = {
			notify: (message: string, type?: string) => { notes.push({ message, type }); },
			setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
		} as unknown as ExtensionUIContext;
		await s.bindExtensions({ mode, uiContext, onError: error => { errors.push(error); } });
		const settled = () => new Promise<void>(resolve => {
			const unsubscribe = s.subscribe(event => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
		});
		const reply = (message: AssistantMessage, before?: () => void): FauxResponseFactory => context => { before?.(); contexts.push(JSON.stringify(context.messages)); return message; };
		const displays = () => s.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === DISPLAY ? [(entry.data as { text: string }).text] : []);
		const infos = () => notes.filter(note => note.type === "info").map(note => note.message);
		const snapshot = () => {
			const entry = s.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === SNAPSHOT);
			return entry?.type === "custom" ? entry.data as State : undefined;
		};
		const run = async (text: string) => { const done = settled(); await s.prompt(text); await done; };
		// Displays reach the user through exactly one channel and never become session messages.
		const shown = () => {
			if (mode === "tui") expect(infos()).toEqual([]); else expect(displays()).toEqual([]);
			expect(s.messages.some(message => message.role === "custom" && message.customType === DISPLAY)).toBe(false);
			expect(s.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === DISPLAY)).toBe(false);
			return mode === "tui" ? displays() : infos();
		};
		return { session: s, faux, notes, statuses, errors, contexts, reply, displays, snapshot, run, shown, cleanup };
	} catch (error) { await cleanup(); throw error; }
}

it.each(["tui", "rpc"] as const)("returns an unapproved proposal on resume as a %s display outside the model context", async mode => {
	const h = await displaySession(mode);
	try {
		h.faux.setResponses([h.reply(fauxAssistantMessage([fauxToolCall("autoresearch_baseline", BASELINE)])), h.reply(fauxAssistantMessage("The baseline is 123 ms."))]);
		await h.run("/autoresearch optimize compilation speed --max 1");
		await h.session.prompt("/autoresearch pause");
		expect(h.snapshot()?.campaign).toMatchObject({ state: "paused", approved: undefined });
		expect(h.shown()).toEqual([]);
		await h.session.prompt("/autoresearch resume");
		expect(h.snapshot()?.campaign?.state).toBe("awaiting_approval");
		expect(h.faux.state.callCount).toBe(2);
		const [review, ...rest] = h.shown();
		expect(rest).toEqual([]);
		expect(review).toContain(METHODOLOGY); expect(review).toContain("Baseline samples"); expect(review).toContain("State: awaiting_approval");
		h.faux.setResponses([h.reply(fauxAssistantMessage("It is 123 ms."))]);
		await h.run("What is the baseline?");
		expect(h.faux.state.callCount).toBe(3);
		const after = h.contexts.at(-1)!;
		expect(after).toContain("What is the baseline?");
		expect(after).not.toContain("State: awaiting_approval"); expect(after).not.toContain(DISPLAY);
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 15_000);

it.each(["tui", "rpc", "print"] as const)("shows an empty /research-report as a %s display outside the model context", async mode => {
	const h = await displaySession(mode);
	try {
		for (const command of ["/research-report", "/research-report status", "/research-report results"]) await h.session.prompt(command);
		expect(h.shown()).toEqual(Array(3).fill("No research report. Start with /autoresearch <target>."));
		expect(h.faux.state.callCount).toBe(0);
		h.faux.setResponses([h.reply(fauxAssistantMessage("Nothing yet."))]);
		await h.run("Is there any research?");
		expect(h.contexts).toHaveLength(1);
		expect(h.contexts[0]).toContain("Is there any research?");
		expect(h.contexts[0]).not.toContain("No research report"); expect(h.contexts[0]).not.toContain(DISPLAY);
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 15_000);

it("registers the display entry renderer at activation in every mode and still renders older display messages", async () => {
	const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	const keys: KeybindingHints = { keyText: keybinding => keybinding, keyHint: (keybinding, description) => `${keybinding} ${description}` };
	for (const mode of ["tui", "rpc", "print"] as const) {
		const h = await displaySession(mode);
		try {
			const entry = h.session.extensionRunner.getEntryRenderer(DISPLAY);
			expect(entry).toBeTypeOf("function");
			for (const expanded of [false, true]) {
				const rendered = entry!({ type: "custom", customType: DISPLAY, id: "display", parentId: null, timestamp: "", data: { text: "Research target: compile faster\n\nState: paused" } } as never, { ...keys, expanded }, theme)!.render(80).join("\n");
				expect(rendered).toContain("Research target: compile faster"); expect(rendered).toContain("State: paused");
			}
			const legacy = h.session.extensionRunner.getMessageRenderer(DISPLAY);
			expect(legacy).toBeTypeOf("function");
			expect(legacy!({ role: "custom", customType: DISPLAY, display: true, timestamp: 0, content: "Research target: an older session\nState: stopped" } as never, { ...keys, expanded: false, outputPad: 0 }, theme)!.render(80).join("\n")).toContain("Research target: an older session");
		} finally { await h.cleanup(); }
	}
}, 15_000);

it("restores the latest snapshot when display entries follow it and approves the same proposal", async () => {
	const h = await displaySession("tui");
	try {
		h.faux.setResponses([h.reply(fauxAssistantMessage([fauxToolCall("autoresearch_baseline", BASELINE)])), h.reply(fauxAssistantMessage("The baseline is 123 ms."))]);
		await h.run("/autoresearch optimize compilation speed --max 1");
		const proposed = h.snapshot()!; const key = approvalKey(proposed);
		await h.session.prompt("/autoresearch status"); await h.session.prompt("/research-report");
		expect(h.session.sessionManager.getBranch().filter(entry => !(entry.type === "custom" && entry.customType === "pi-extensions.command")).slice(-2)).toMatchObject([{ type: "custom", customType: DISPLAY }, { type: "custom", customType: DISPLAY }]);
		await h.session.reload();
		expect(h.notes.filter(note => note.type !== "info")).toEqual([]);
		expect(h.statuses.get("autoresearch")).toContain("awaiting approval");
		expect(h.snapshot()).toEqual(proposed);
		await h.session.prompt("/autoresearch status");
		expect(h.shown()).toHaveLength(3);
		expect(h.shown().at(-1)).toContain(METHODOLOGY); expect(h.shown().at(-1)).toContain("State: awaiting_approval");
		h.faux.setResponses([
			h.reply(fauxAssistantMessage([fauxToolCall("autoresearch_measure", {})])),
			h.reply(fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "complete", message: "No further useful experiment in this fixture." })])),
			h.reply(fauxAssistantMessage("Research complete.")),
		]);
		await h.run("/autoresearch approve");
		expect(h.snapshot()).toMatchObject({ campaign: { state: "complete", iterations: 1, approved: key }, report: { phase: "complete", provenance: "tool-measured" } });
		for (const context of h.contexts.slice(2)) { expect(context).not.toContain("State: awaiting_approval"); expect(context).not.toContain(DISPLAY); }
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 15_000);

it("keeps status displays shown during a running setup pass out of that pass's later requests", async () => {
	const h = await displaySession("tui");
	try {
		const pending: Promise<void>[] = [];
		const status = () => { pending.push(h.session.prompt("/autoresearch status")); };
		h.faux.setResponses([
			h.reply(fauxAssistantMessage([fauxToolCall("autoresearch_baseline", BASELINE)]), status),
			h.reply(fauxAssistantMessage([fauxToolCall("autoresearch_update", { phase: "checking", message: "Baseline recorded; explaining the methodology." })]), status),
			h.reply(fauxAssistantMessage("The baseline is 123 ms.")),
		]);
		await h.run("/autoresearch optimize compilation speed --max 1"); await Promise.all(pending);
		const [preparing, reviewing, ...rest] = h.shown();
		expect(rest).toEqual([]);
		expect(preparing).toBe("Research target: optimize compilation speed\nState: preparing");
		expect(reviewing).toContain(METHODOLOGY); expect(reviewing).toContain("State: awaiting_approval");
		const branch = h.session.sessionManager.getBranch();
		expect(branch.findLastIndex(entry => entry.type === "custom" && entry.customType === DISPLAY))
			.toBeLessThan(branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant"));
		h.faux.setResponses([h.reply(fauxAssistantMessage("It is 123 ms."))]);
		await h.run("What is the baseline?");
		expect(h.contexts).toHaveLength(4);
		const [, , explained, asked] = h.contexts as [string, string, string, string];
		expect(explained).toContain("Baseline samples"); expect(asked).toContain("Baseline recorded; explaining the methodology.");
		for (const context of [explained, asked]) { expect(context).not.toContain("State: "); expect(context).not.toContain(DISPLAY); }
		expect(h.snapshot()?.campaign?.state).toBe("awaiting_approval");
		expect(h.errors).toEqual([]);
	} finally { await h.cleanup(); }
}, 15_000);
