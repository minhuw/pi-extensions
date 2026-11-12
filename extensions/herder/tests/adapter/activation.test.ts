import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import herderExtension from "../../index.ts";
import { HERDER_MENTION_RE, HERDER_TOOL_NAMES, SKILL_LOCATIONS_MESSAGE } from "../../src/adapter/activation.ts";
import { SKILL_PATH, SKILLS_DIR } from "../../src/adapter/prompts.ts";
import { createGitFixture } from "../support/git-fixture.ts";
import { standingRegistry } from "../../src/adapter/standing.ts";

const extensionRoot = fileURLToPath(new URL("../../", import.meta.url));
const skillsRoot = join(extensionRoot, "skills");

/** A real AgentSession on the faux provider. Binding loads Herder but never starts a run or touches git. */
async function sessionAt(directory: string, manager = SessionManager.inMemory(directory)) {
	let api!: ExtensionAPI;
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "herder-activation-api", provider: "herder-activation", models: [{ id: "test" }] });
	const resources = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [skillsRoot],
		additionalPromptTemplatePaths: [],
		extensionFactories: [(pi) => { api = pi; pi.registerProvider(faux.provider); herderExtension(pi); }],
	});
	await resources.reload();
	expect(resources.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime: runtime,
		model: faux.getModel("test")!,
		resourceLoader: resources,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "bash", "edit", "write"], retry: { enabled: false } }),
	});
	const errors: unknown[] = [];
	const notes: { message: string; type?: string }[] = [];
	const uiContext = { notify: (message: string, type?: string) => { notes.push({ message, type }); }, setStatus: () => {} } as unknown as ExtensionUIContext;
	await session.bindExtensions({ mode: "rpc", uiContext, onError: (error) => { errors.push(error); } });
	const requests: { tools: string[]; systemPrompt: string; raw: string }[] = [];
	const inspect = (message: AssistantMessage): FauxResponseFactory => (context) => {
		requests.push({
			tools: getCurrentTools(context.messages).map((tool) => tool.name),
			systemPrompt: getCurrentSystemPrompt(context.messages),
			raw: JSON.stringify(context.messages),
		});
		return message;
	};
	const settled = () => new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe((event) => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
	});
	const run = async (text: string) => { const done = settled(); await session.prompt(text); await done; };
	const locations = () => session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === SKILL_LOCATIONS_MESSAGE);
	const dispose = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	return { session, api, faux, errors, notes, requests, inspect, run, locations, dispose };
}

function expectHerderInactive(tools: readonly string[]) {
	for (const name of HERDER_TOOL_NAMES) expect(tools).not.toContain(name);
}
function expectHerderActive(tools: readonly string[]) {
	for (const name of HERDER_TOOL_NAMES) expect(tools).toContain(name);
}

const sessionDirs: string[] = [];
afterEach(async () => {
	standingRegistry().grants.clear();
	for (const directory of sessionDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Herder explicit-mention activation", () => {
	it("hides all three skills from <available_skills> and matches only herder mentions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "herder-skills-hidden-"));
		sessionDirs.push(directory);
		const agentDir = join(directory, "agent");
		await mkdir(agentDir);
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalSkillPaths: [skillsRoot],
			additionalPromptTemplatePaths: [],
		});
		await loader.reload();
		const { skills, diagnostics } = loader.getSkills();
		expect(diagnostics).toEqual([]);
		const herderSkills = skills.filter((skill) => skill.name.startsWith("herder"));
		expect(herderSkills.map((skill) => skill.name).sort()).toEqual(["herder", "herder-improve", "herder-simplify"]);
		for (const skill of herderSkills) expect(skill.disableModelInvocation).toBe(true);
		expect(formatSkillsForPrompt(herderSkills)).toBe("");

		expect(HERDER_MENTION_RE.test("Use herder to add a greeting")).toBe(true);
		expect(HERDER_MENTION_RE.test("/herder-improve quick")).toBe(true);
		expect(HERDER_MENTION_RE.test("/skill:herder-simplify")).toBe(true);
		expect(HERDER_MENTION_RE.test("herder_run { action: \"start\" }")).toBe(true);
		expect(HERDER_MENTION_RE.test("Inspect @extensions/herder/")).toBe(true);
		expect(HERDER_MENTION_RE.test("Improve error messages and simplify the config parser")).toBe(false);
	});

	it("omits herder_* tools and <available_skills> on startup and ordinary prompts, without starting a run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "herder-inactive-"));
		sessionDirs.push(directory);
		const h = await sessionAt(directory);
		try {
			expectHerderInactive(h.session.getActiveToolNames());
			h.faux.setResponses([h.inspect(fauxAssistantMessage("Improved the parser."))]);
			await h.run("Improve error messages and simplify the config parser");
			expect(h.requests).toHaveLength(1);
			expectHerderInactive(h.requests[0]!.tools);
			expect(h.requests[0]!.systemPrompt).not.toContain("<name>herder");
			expect(h.requests[0]!.systemPrompt).not.toContain(SKILLS_DIR);
			expect(h.locations()).toEqual([]);
			expectHerderInactive(h.session.getActiveToolNames());
			expect(h.notes).toEqual([]);
			expect(h.errors).toEqual([]);
		} finally { await h.dispose(); }
	});

	it.each([
		{ label: "explicit herder mention", input: "Use herder to add a greeting", expectLocations: 1 },
		{ label: "/skill:herder", input: "/skill:herder add a greeting", expectLocations: 0 },
	])("activates herder_* on Turn 1 for $label", async ({ input, expectLocations }) => {
		const directory = await mkdtemp(join(tmpdir(), "herder-mention-"));
		sessionDirs.push(directory);
		const h = await sessionAt(directory);
		try {
			expectHerderInactive(h.session.getActiveToolNames());
			h.faux.setResponses([
				h.inspect(fauxAssistantMessage("Herder is ready.")),
				fauxAssistantMessage("Still ready."),
			]);
			await h.run(input);
			expectHerderActive(h.requests[0]!.tools);
			expectHerderActive(h.session.getActiveToolNames());
			expect(h.requests[0]!.raw).toContain(SKILLS_DIR.replaceAll("\\", "\\\\"));
			expect(h.locations()).toHaveLength(expectLocations);
			if (expectLocations) {
				expect(h.locations()[0]).toMatchObject({ display: false, content: expect.stringContaining(SKILL_PATH) });
				expect(h.requests[0]!.raw).toContain("Herder skills (read SKILL.md only when running that workflow):");
				await h.run("Plan the herder workflow next");
				expect(h.locations()).toHaveLength(1);
				h.session.sessionManager.appendCompaction("Earlier context compacted", h.session.sessionManager.getBranch()[0]!.id, 100);
				await h.run("Continue the herder plan");
				expect(h.locations()).toHaveLength(2);
			}
			expect(h.errors).toEqual([]);
		} finally { await h.dispose(); }
	});

	it("activates herder_* on /herder <goal> without duplicating skill-locations or touching the checkout", async () => {
		const fixture = createGitFixture();
		sessionDirs.push(fixture.dir);
		const h = await sessionAt(fixture.dir);
		try {
			expectHerderInactive(h.session.getActiveToolNames());
			h.faux.setResponses([h.inspect(fauxAssistantMessage("Draft the goal."))]);
			await h.run("/herder add a greeting");
			expect(h.requests).toHaveLength(1);
			expectHerderActive(h.requests[0]!.tools);
			expect(h.requests[0]!.raw).toContain("Herder instructions:");
			expect(h.requests[0]!.raw).toContain("# Herder");
			expect(h.locations()).toEqual([]);
			expect(h.notes.some((note) => note.message.startsWith("Started Herder run "))).toBe(true);
			expect(h.errors).toEqual([]);
		} finally { await h.dispose(); }
	});

	it("activates herder_* on /herder-improve with its audit skill, keeping the run startable later", async () => {
		const fixture = createGitFixture();
		sessionDirs.push(fixture.dir);
		const h = await sessionAt(fixture.dir);
		try {
			h.faux.setResponses([h.inspect(fauxAssistantMessage("Audit started."))]);
			await h.run("/herder-improve quick");
			expectHerderActive(h.requests[0]!.tools);
			expect(h.requests[0]!.raw).toContain("herder-improve instructions:");
			expect(h.locations()).toEqual([]);
			expect(h.errors).toEqual([]);
		} finally { await h.dispose(); }
	});

	it("activates herder_* on a selfdrive custom message and records skill locations once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "herder-selfdrive-"));
		sessionDirs.push(directory);
		const h = await sessionAt(directory);
		try {
			expectHerderInactive(h.session.getActiveToolNames());
			h.faux.setResponses([h.inspect(fauxAssistantMessage("Selfdrive continuing."))]);
			const done = new Promise<void>((resolve) => {
				const unsubscribe = h.session.subscribe((event) => { if (event.type === "agent_settled") { unsubscribe(); resolve(); } });
			});
			await h.session.extensionRunner.emitBeforeAgentStart({
				messageType: "custom",
				message: { role: "custom", customType: "selfdrive", content: "Self-driving mode is on. Run herder-improve and herder-simplify audits, then use Herder runs.", display: false },
			} as never, { selectedTools: h.api.getActiveTools() } as never);
			h.api.sendMessage(
				{
					customType: "selfdrive",
					content: "Self-driving mode is on. Run herder-improve and herder-simplify audits, then use Herder runs.",
					display: false,
					details: { kind: "start" },
				},
				{ triggerTurn: true },
			);
			await done;
			expect(h.requests).toHaveLength(1);
			expectHerderActive(h.requests[0]!.tools);
			expect(h.locations()).toHaveLength(1);
			expect(h.errors).toEqual([]);
		} finally { await h.dispose(); }
	});

	it("restores herder_* on session_start/session_tree for Herder branches but not pre-Herder leaves", async () => {
		const directory = await mkdtemp(join(tmpdir(), "herder-restore-"));
		sessionDirs.push(directory);
		const manager = SessionManager.create(directory, directory);
		const h = await sessionAt(directory, manager);
		try {
			h.faux.setResponses([fauxAssistantMessage("Before Herder.")]);
			await h.run("Improve error messages and simplify the config parser");
			const beforeLeaf = manager.getLeafId()!;
			expectHerderInactive(h.session.getActiveToolNames());
			h.faux.setResponses([fauxAssistantMessage("Herder mentioned.")]);
			await h.run("Use herder to add a greeting");
			const herderLeaf = manager.getLeafId()!;
			expectHerderActive(h.session.getActiveToolNames());
			await h.session.navigateTree(beforeLeaf);
			expectHerderInactive(h.session.getActiveToolNames());
			await h.session.navigateTree(herderLeaf);
			expectHerderActive(h.session.getActiveToolNames());
			h.session.setActiveToolsByName(["read", "bash", "edit", "write"]);
			await h.session.reload();
			expectHerderActive(h.session.getActiveToolNames());
			expect(h.errors).toEqual([]);
		} finally { await h.dispose(); }

		const reopenedManager = SessionManager.open(manager.getSessionFile()!, directory);
		const reopened = await sessionAt(directory, reopenedManager);
		try {
			expectHerderActive(reopened.session.getActiveToolNames());
			expect(reopened.errors).toEqual([]);
		} finally { await reopened.dispose(); }
	});
});
