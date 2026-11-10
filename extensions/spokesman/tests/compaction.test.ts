import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { SPOKESMAN_REWRITE_ENTRY, type SpokesmanRewriteData } from "../index.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const API = "spokesman-test-api";
const PROVIDER = "faux-openai";
const MAIN_MODEL = "gpt-6-sol";

type Message = { role: string; content: unknown };

const textOf = ({ content }: Message): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

const assistantTexts = (messages: Message[]): string[] =>
	messages.filter((message) => message.role === "assistant").map(textOf);

describe("spokesman rewrites in the context of a compacted session", () => {
	let root: string;
	let previousAgentDir: string | undefined;
	let clock: number;
	const started: { dispose(): Promise<void> }[] = [];
	const agentDir = () => join(root, "agent");
	const sessionDir = () => join(root, "sessions");
	const cwd = () => join(root, "work");
	const newManager = () => SessionManager.create(cwd(), sessionDir());

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-spokesman-compaction-"));
		await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir();
		clock = Date.UTC(2026, 0, 1);
	});

	afterEach(async () => {
		try {
			for (const runtime of started.splice(0)) await runtime.dispose();
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	});

	const user = (manager: SessionManager, text: string): string =>
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: (clock += 1000),
		});

	const assistant = (manager: SessionManager, text: string): string =>
		manager.appendMessage({
			...fauxAssistantMessage(text, { timestamp: (clock += 1000) }),
			api: API,
			provider: PROVIDER,
			model: MAIN_MODEL,
		});

	// Recorded like /spokesman rewrite: the stored reply keeps its original text.
	const rewrite = (manager: SessionManager, targetEntryId: string, rewrittenText: string): void => {
		const target = manager.getEntry(targetEntryId);
		const data: SpokesmanRewriteData = {
			targetEntryId,
			originalText: target?.type === "message" ? textOf(target.message as Message) : "",
			rewrittenText,
			originalModel: MAIN_MODEL,
			spokesmanModel: "gpt-5.4",
			spokesmanProvider: PROVIDER,
			mode: "auto",
			signals: ["manual"],
			timestamp: (clock += 1000),
		};
		manager.appendCustomEntry(SPOKESMAN_REWRITE_ENTRY, data);
	};

	/** Assistant replies in the context Pi builds from the branch, before any extension sees it. */
	const builtByPi = (manager: SessionManager): string[] =>
		assistantTexts(manager.buildSessionContext().messages as Message[]);

	/** Resumes the branch in a real Pi session and returns the assistant replies the next request carries. */
	async function sentToModel(manager: SessionManager): Promise<string[]> {
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const faux = fauxProvider({ api: API, provider: PROVIDER, models: [{ id: MAIN_MODEL }] });
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
		});
		const requests: Message[][] = [];
		faux.setResponses([
			(context) => {
				requests.push(JSON.parse(JSON.stringify(context.messages)) as Message[]);
				return fauxAssistantMessage("Ack.");
			},
		]);

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir: runtimeAgentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [extensionPath],
					extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
				},
			});
			expect(services.resourceLoader.getExtensions().errors).toEqual([]);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(MAIN_MODEL),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: cwd(),
			agentDir: agentDir(),
			sessionManager: manager,
		});
		started.push(runtime);
		const errors: unknown[] = [];
		await runtime.session.bindExtensions({
			mode: "rpc",
			onError: (error) => {
				errors.push(error);
			},
		});

		await runtime.session.prompt("Next question");
		expect(errors).toEqual([]);
		expect(requests).toHaveLength(1);
		return assistantTexts(requests[0]!);
	}

	it("replaces only the rewritten reply when the branch has no compaction", async () => {
		const manager = newManager();
		user(manager, "Q1");
		assistant(manager, "A1");
		user(manager, "Q2");
		rewrite(manager, assistant(manager, "A2"), "A2 rewritten");
		user(manager, "Q3");
		assistant(manager, "A3");

		expect(builtByPi(manager)).toEqual(["A1", "A2", "A3"]);
		expect(await sentToModel(manager)).toEqual(["A1", "A2 rewritten", "A3"]);
	});

	it("replaces only the rewritten replies when a compaction keeps earlier replies", async () => {
		const manager = newManager();
		user(manager, "Q1");
		assistant(manager, "A1");
		const firstKept = user(manager, "Q2");
		assistant(manager, "A2");
		user(manager, "Q3");
		rewrite(manager, assistant(manager, "A3"), "A3 rewritten");
		manager.appendCompaction("Summary up to Q1.", firstKept, 1000);
		user(manager, "Q4");
		rewrite(manager, assistant(manager, "A4"), "A4 rewritten");
		user(manager, "Q5");
		assistant(manager, "A5");

		// Pi sends the summary, the kept replies A2 and A3, then A4 and A5.
		expect(builtByPi(manager)).toEqual(["A2", "A3", "A4", "A5"]);
		expect(await sentToModel(manager)).toEqual(["A2", "A3 rewritten", "A4 rewritten", "A5"]);
	});

	it("applies no rewrite whose target was summarized away", async () => {
		const manager = newManager();
		user(manager, "Q1");
		rewrite(manager, assistant(manager, "A1"), "A1 rewritten");
		const firstKept = user(manager, "Q2");
		assistant(manager, "A2");
		manager.appendCompaction("Summary up to Q1.", firstKept, 1000);
		user(manager, "Q3");
		assistant(manager, "A3");

		expect(builtByPi(manager)).toEqual(["A2", "A3"]);
		expect(await sentToModel(manager)).toEqual(["A2", "A3"]);
	});

	it("replaces only the rewritten reply when a compaction keeps nothing", async () => {
		const manager = newManager();
		user(manager, "Q1");
		rewrite(manager, assistant(manager, "A1"), "A1 rewritten");
		user(manager, "Q2");
		assistant(manager, "A2");
		manager.appendCompaction("Summary up to Q2.", null, 1000);
		user(manager, "Q3");
		rewrite(manager, assistant(manager, "A3"), "A3 rewritten");
		user(manager, "Q4");
		assistant(manager, "A4");

		expect(builtByPi(manager)).toEqual(["A3", "A4"]);
		expect(await sentToModel(manager)).toEqual(["A3 rewritten", "A4"]);
	});

	it("follows the latest compaction when the branch has more than one", async () => {
		const manager = newManager();
		user(manager, "Q1");
		rewrite(manager, assistant(manager, "A1"), "A1 rewritten");
		const firstKeptByFirst = user(manager, "Q2");
		assistant(manager, "A2");
		manager.appendCompaction("Summary up to Q1.", firstKeptByFirst, 1000);
		user(manager, "Q3");
		rewrite(manager, assistant(manager, "A3"), "A3 rewritten");
		const firstKeptBySecond = user(manager, "Q4");
		assistant(manager, "A4");
		manager.appendCompaction("Summary up to Q3.", firstKeptBySecond, 1000);
		user(manager, "Q5");
		rewrite(manager, assistant(manager, "A5"), "A5 rewritten");
		user(manager, "Q6");
		assistant(manager, "A6");

		expect(builtByPi(manager)).toEqual(["A4", "A5", "A6"]);
		expect(await sentToModel(manager)).toEqual(["A4", "A5 rewritten", "A6"]);
	});

	it("keeps the pairing when the latest compaction keeps replies from before an earlier one", async () => {
		const manager = newManager();
		user(manager, "Q1");
		assistant(manager, "A1");
		const firstKept = user(manager, "Q2");
		assistant(manager, "A2");
		manager.appendCompaction("Summary up to Q1.", firstKept, 1000);
		user(manager, "Q3");
		rewrite(manager, assistant(manager, "A3"), "A3 rewritten");
		manager.appendCompaction("Summary up to Q1, again.", firstKept, 1000);
		user(manager, "Q4");
		rewrite(manager, assistant(manager, "A4"), "A4 rewritten");
		user(manager, "Q5");
		assistant(manager, "A5");

		expect(builtByPi(manager)).toEqual(["A2", "A3", "A4", "A5"]);
		expect(await sentToModel(manager)).toEqual(["A2", "A3 rewritten", "A4 rewritten", "A5"]);
	});

	it("pairs replies with their own entries when Pi omits a kept reply from the context", async () => {
		const manager = newManager();
		user(manager, "Q1");
		assistant(manager, "A1");
		const firstKept = user(manager, "Q2");
		const omitted = assistant(manager, "A2");
		user(manager, "Q3");
		rewrite(manager, assistant(manager, "A3"), "A3 rewritten");
		manager.appendCompaction("Summary up to Q1.", firstKept, 1000);
		user(manager, "Q4");
		assistant(manager, "A4");
		user(manager, "Q5");
		rewrite(manager, assistant(manager, "A5"), "A5 rewritten");
		manager.appendContextEdit(omitted, null);

		expect(builtByPi(manager)).toEqual(["A3", "A4", "A5"]);
		expect(await sentToModel(manager)).toEqual(["A3 rewritten", "A4", "A5 rewritten"]);
	});
});
