// The answer-language check: its classifier, and real Pi sessions on the faux provider asserting on what the provider receives.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type CreateAgentSessionRuntimeFactory, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { ANSWER_CHECK, checkAnswer, languageScripts, proseOf } from "../index.ts";

// Load by path, as Pi does.
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const correction = (language: string) => `Your last answer was not in ${language}. Write it again in ${language}, in full; keep code, identifiers, commands, and paths unchanged.`;
const switchMessage = (active: string) => `Respond in ${active}, whatever language the user writes in. This overrides the default language. Keep code, identifiers, commands, and file paths unchanged.`;

const ENGLISH = "I updated the parser so that it handles empty input and input made only of whitespace, added three tests that cover the empty string, newlines, and tabs, and ran the whole suite again on every supported platform.";
const CHINESE = "我已经更新了解析器，现在它能够正确处理空输入和只包含空白字符的输入。为此我新增了三个测试用例，分别覆盖空字符串、换行符和制表符的情况。随后我在本地重新运行了完整的测试套件，所有测试都顺利通过。下面是修改后的核心函数，供你审阅。如果你希望保留旧的行为，我们也可以通过一个配置选项来切换。";
const CODE = [
	"export function parseInput(source: string): Token[] {", "\tif (source.trim().length === 0) return [];", "\tconst tokens = tokenize(source);",
	"\treturn tokens.filter((token) => token.kind !== \"whitespace\");", "}", "export function tokenize(source: string): Token[] {",
	"\treturn source.split(/\\s+/).map((text) => ({ kind: classify(text), text }));", "}", "function classify(text: string): TokenKind {",
	"\treturn text.length === 0 ? \"whitespace\" : /^[0-9]+$/.test(text) ? \"number\" : \"identifier\";", "}",
].join("\n").repeat(2);
const CHINESE_WITH_CODE = `${CHINESE}\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\n修改位于 \`parseInput\` 和 extensions/parser/index.ts，参考 [文档](https://example.com/docs/parser/tokenize-and-classify)。`;
const SHORT_ENGLISH = "Done: all tests pass.";

describe("the classifier", () => {
	it("checks only languages with a distinctive script, by English or native name and ignoring case", () => {
		expect([
			"Chinese", "中文", "简体中文", "繁體中文", "japanese", "日本語", "KOREAN", "한국어", "Russian", "Ukrainian", "Bulgarian", "Serbian (Cyrillic)", "Русский", "Українська",
			"Greek", "ΕΛΛΗΝΙΚΆ", "Arabic", "العربية", "Persian", "فارسی", "Hebrew", "עברית", "Thai", "ไทย", "Hindi", "हिन्दी", "  chinese  ",
		].map((name) => languageScripts(name) !== undefined)).not.toContain(false);
		expect(languageScripts("Japanese")).toEqual(["Han", "Hiragana", "Katakana"]);
		expect(languageScripts("serbian (cyrillic)")).toEqual(["Cyrillic"]);
		for (const name of ["English", "German", "Deutsch", "French", "Français", "Spanish", "Serbian", "Vietnamese", "Klingon", ""]) {
			expect(languageScripts(name)).toBeUndefined();
			expect(checkAnswer(ENGLISH, name)).toBeUndefined();
		}
		expect(ANSWER_CHECK).toEqual({ minLetters: 40, minShare: 0.3 });
		// A short English follow-up, the most common failure in real sessions, is long enough to judge.
		expect(checkAnswer("Sure, I pushed the fix to master and the tests pass on CI now. Let me know if you want the release notes updated too.", "简体中文")?.violation).toBe(true);
		expect(checkAnswer(SHORT_ENGLISH, "简体中文")?.violation).toBe(false);
	});

	it.each<[string, string, string, boolean]>([
		["an English answer", "简体中文", ENGLISH, true],
		["a Chinese answer", "简体中文", CHINESE, false],
		["a Chinese answer with code, inline code, a path, and a link", "Chinese", CHINESE_WITH_CODE, false],
		["the same code outside a fence", "Chinese", `${CHINESE}\n${CODE}`, true],
		["a short English answer", "Chinese", SHORT_ENGLISH, false],
		["a Japanese answer", "Japanese", "パーサーを更新して、空の入力と空白だけの入力を正しく処理できるようにしました。空文字列、改行、タブを確かめるテストを三つ追加し、対応するすべての環境でテスト全体をもう一度実行して、すべて成功することを確認しました。古い動作を残したい場合は、設定で切り替えられるようにもできます。", false],
		["an English answer under Japanese", "日本語", ENGLISH, true],
		["a Korean answer", "Korean", "파서를 업데이트해서 빈 입력과 공백만 있는 입력을 올바르게 처리하도록 했습니다. 빈 문자열, 줄바꿈, 탭을 확인하는 테스트 세 개를 추가했고, 지원하는 모든 플랫폼에서 전체 테스트를 다시 실행해 모두 통과하는 것을 확인했습니다. 이전 동작이 필요하면 설정으로 바꿀 수 있습니다.", false],
		["a Russian answer", "русский", "Я обновил парсер, чтобы он правильно обрабатывал пустой ввод и ввод только из пробелов, добавил три теста для пустой строки, переводов строки и табуляции и снова запустил весь набор тестов на всех поддерживаемых платформах.", false],
		["a Greek answer", "Greek", "Ενημέρωσα τον αναλυτή ώστε να χειρίζεται σωστά την κενή είσοδο και την είσοδο μόνο με κενά, πρόσθεσα τρία τεστ για την κενή συμβολοσειρά, τις αλλαγές γραμμής και τα tabs, και έτρεξα ξανά όλα τα τεστ.", false],
		["an Arabic answer", "Arabic", "قمت بتحديث المحلل حتى يتعامل بشكل صحيح مع الإدخال الفارغ والإدخال الذي يحتوي على مسافات فقط، وأضفت ثلاثة اختبارات للسلسلة الفارغة والأسطر الجديدة وعلامات الجدولة، ثم شغلت مجموعة الاختبارات كاملة مرة أخرى.", false],
		["an English answer under Hebrew", "Hebrew", ENGLISH, true],
		["an English answer under Thai", "Thai", ENGLISH, true],
		["an English answer under Hindi", "हिन्दी", ENGLISH, true],
	])("judges %s under %s", (_name, language, text, violation) => {
		expect(checkAnswer(text, language)?.violation).toBe(violation);
	});

	it("counts the prose of an answer only", () => {
		const check = checkAnswer(CHINESE_WITH_CODE, "Chinese")!;
		expect(check.letters).toBeGreaterThanOrEqual(ANSWER_CHECK.minLetters);
		expect(check.inScript).toBe(check.letters);
		expect(proseOf("中文 `inline code` 和 ``a ` b`` 结束")).not.toMatch(/[a-z]/);
		expect(proseOf("see [the docs](https://example.com/a/b \"title\") now")).toBe("see [the docs] now");
		expect(proseOf("visit https://example.com/path?q=1 或 www.example.org/x 吧").replace(/\s+/g, " ")).toBe("visit 或 吧");
		expect(proseOf("编辑src/index.ts和C:\\work\\file.txt以及 ./scripts/build.mjs 和 package.json").replace(/\s+/g, "")).toBe("编辑和以及和");
		expect(proseOf("before\n~~~\nhidden\n```\nstill hidden\n~~~\nafter\n```js\nunclosed")).toBe("before\nafter");
	});

	it("applies thresholds given to it", () => {
		expect(checkAnswer(SHORT_ENGLISH, "Chinese", { minLetters: 5, minShare: 0.3 })?.violation).toBe(true);
		expect(checkAnswer(ENGLISH, "Chinese", { minLetters: 1000, minShare: 0.3 })?.violation).toBe(false);
	});
});

type Message = { role: string; content: unknown };
interface Captured { system: string; conversation: Message[] }
type Step = string | AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return { system: getCurrentSystemPrompt(messages), conversation: copy.filter((message) => message.role !== "system") };
};
const textOf = ({ content }: Message) => typeof content === "string" ? content : (content as { text?: string }[]).map((part) => part.text ?? "").join("");
/** What followed the run's starting message in a request. */
const afterPrompt = (request: Captured, prompt: string) => {
	const texts = request.conversation.map(textOf);
	const start = texts.lastIndexOf(prompt);
	expect(start).toBeGreaterThanOrEqual(0);
	return texts.slice(start + 1);
};
/** The system prompt is unchanged, and `later` starts with every conversation message of `earlier`, byte for byte. */
const expectSamePrefix = (later: Captured, earlier: Captured) => {
	expect(later.system).toBe(earlier.system);
	expect(JSON.stringify(later.conversation.slice(0, earlier.conversation.length))).toBe(JSON.stringify(earlier.conversation));
};

let root: string;
let previousAgentDir: string | undefined;
const started: { dispose(): Promise<void> }[] = [];
const agentDir = () => join(root, "agent");
const sessionDir = () => join(root, "sessions");
const cwd = () => join(root, "work");
const writeDefault = (name: string) => writeFile(join(agentDir(), "language.json"), JSON.stringify({ default: name }));

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-language-check-"));
	await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir();
});

afterEach(async () => {
	try {
		for (const harness of started.splice(0)) await harness.dispose();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

/** A UI context that records notifications. A plain object: Pi spreads it. */
function recordingUi() {
	const noop = () => {};
	return {
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
		onTerminalInput: () => noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
		setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
		addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: noop, notify: noop, setStatus: noop,
	} as unknown as ExtensionUIContext;
}

async function start(options: { mode?: ExtensionContext["mode"] } = {}) {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: "language-check-test-api", provider: "language-check-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const requests: Captured[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: cwd(), agentDir: agentDir(), sessionManager: SessionManager.create(cwd(), sessionDir()) });
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions({
		mode: options.mode ?? "rpc",
		uiContext: recordingUi(),
		onError: (error) => { errors.push(error); },
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (newOptions) => runtime.newSession(newOptions),
			fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
			navigateTree: (targetId, treeOptions) => runtime.session.navigateTree(targetId, treeOptions),
			switchSession: (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
			reload: () => runtime.session.reload(),
		},
	});
	runtime.setRebindSession(bind);
	await bind();
	const harness = {
		runtime, requests, errors,
		get session() { return runtime.session; },
		/** Answer the next requests with `steps`, then with "ok". */
		reply(...steps: Step[]) {
			const all = [...steps, ...Array.from({ length: 10 }, () => "ok")];
			faux.setResponses(all.map((step): FauxResponseFactory => async ({ messages }) => {
				requests.push(capture(messages));
				return typeof step === "string" ? fauxAssistantMessage(step) : typeof step === "function" ? step() : step;
			}));
		},
		/** Run one prompt and return the requests it made. */
		async run(prompt: string, ...steps: Step[]) {
			harness.reply(...steps);
			const before = requests.length;
			await runtime.session.prompt(prompt);
			return requests.slice(before);
		},
		command: (text: string) => runtime.session.prompt(text),
		corrections: () => runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "language" && String(entry.content).startsWith("Your last answer") ? [entry] : []),
		/** The text of the last assistant message on the branch. */
		lastAnswer() {
			const entry = runtime.session.sessionManager.getBranch().findLast((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
			return entry?.type === "message" ? textOf(entry.message as Message) : undefined;
		},
		dispose: () => runtime.dispose(),
	};
	started.push(harness);
	return harness;
}

describe("in a session", () => {
	it("corrects an English answer under a 简体中文 default once, with a hidden message, and keeps the rewrite", async () => {
		await writeDefault("简体中文");
		const h = await start();
		const [first, second, ...rest] = await h.run("总结一下", ENGLISH, CHINESE);
		expect(rest).toEqual([]);
		expect(afterPrompt(first, "总结一下")).toEqual([]);
		expectSamePrefix(second, first);
		expect(afterPrompt(second, "总结一下")).toEqual([ENGLISH, correction("简体中文")]);
		expect(h.corrections().map(({ content, display }) => ({ content, display }))).toEqual([{ content: correction("简体中文"), display: false }]);
		expect(h.lastAnswer()).toBe(CHINESE);
		expect(h.errors).toEqual([]);
	});

	it("checks against a mid-session switch", async () => {
		const h = await start();
		await h.run("one", ENGLISH);
		await h.command("/language 简体中文");
		const requests = await h.run("two", ENGLISH, CHINESE);
		expect(requests).toHaveLength(2);
		expect(afterPrompt(requests[1], "two")).toEqual([switchMessage("简体中文"), ENGLISH, correction("简体中文")]);
		expect(h.corrections()).toHaveLength(1);
	});

	it("checks the language the run started with, not a switch made during it", async () => {
		await writeDefault("English");
		const h = await start();
		await h.run("one", "ok");
		const during = await h.run("two", async () => {
			await h.command("/language Japanese");
			return fauxAssistantMessage(ENGLISH);
		});
		expect(during).toHaveLength(1);
		const next = await h.run("three", ENGLISH, "ok");
		expect(next).toHaveLength(2);
		expect(afterPrompt(next[1], "three")).toEqual([switchMessage("Japanese"), ENGLISH, correction("Japanese")]);
	});

	it("passes a Chinese answer with code blocks", async () => {
		await writeDefault("简体中文");
		const h = await start();
		expect(await h.run("写代码", CHINESE_WITH_CODE)).toHaveLength(1);
		expect(h.corrections()).toEqual([]);
	});

	it("never checks a short answer", async () => {
		await writeDefault("简体中文");
		const h = await start();
		expect(await h.run("好了吗", SHORT_ENGLISH)).toHaveLength(1);
		expect(h.corrections()).toEqual([]);
	});

	it.each(["English", "German", "French"])("never checks a %s target", async (language) => {
		await writeDefault(language);
		const h = await start();
		expect(await h.run("one", CHINESE)).toHaveLength(1);
		await h.command("/language 简体中文");
		await h.command(`/language ${language}`);
		expect(await h.run("two", CHINESE)).toHaveLength(1);
		expect(h.corrections()).toEqual([]);
	});

	it("corrects at most once per run and again in the next run", async () => {
		await writeDefault("Russian");
		const h = await start();
		const first = await h.run("one", ENGLISH, ENGLISH);
		expect(first).toHaveLength(2);
		expect(h.lastAnswer()).toBe(ENGLISH);
		expect(h.corrections()).toHaveLength(1);
		const second = await h.run("two", ENGLISH, ENGLISH);
		expect(second).toHaveLength(2);
		expect(afterPrompt(second[1], "two")).toEqual([ENGLISH, correction("Russian")]);
		expect(h.corrections()).toHaveLength(2);
	});

	it("skips an aborted run", async () => {
		await writeDefault("简体中文");
		const h = await start();
		const requests = await h.run("one", () => {
			void h.session.abort();
			return fauxAssistantMessage(ENGLISH);
		});
		expect(requests).toHaveLength(1);
		expect(h.corrections()).toEqual([]);
		expect(await h.run("two", ENGLISH, CHINESE)).toHaveLength(2);
	});

	it.each(["aborted", "error", "length"] as const)("skips a final answer that stopped with %s", async (stopReason) => {
		await writeDefault("简体中文");
		const h = await start();
		expect(await h.run("one", fauxAssistantMessage(ENGLISH, { stopReason }))).toHaveLength(1);
		expect(h.corrections()).toEqual([]);
	});

	it.each(["print", "json"] as const)("leaves %s mode alone", async (mode) => {
		await writeDefault("简体中文");
		const h = await start({ mode });
		expect(await h.run("one", ENGLISH)).toHaveLength(1);
		expect(h.corrections()).toEqual([]);
	});
});
