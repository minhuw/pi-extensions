import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentDream } from "../../memory/dream/index.ts";
import { FakePika } from "../support/pika-server.ts";
import { fakeSpawner, leaseRequests, RecordingUI, resetDreams, serveDreams, until } from "./support/dream.ts";
import { type Harness, PROJECT_SCOPE, setCredentials, startSession, USER_SCOPE, Workspace } from "./support/runtime.ts";

// The repository's first resolution runs git; the gate holds it so the test can act meanwhile.
const gate = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined, entered: 0 }));
vi.mock("../../repository.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../repository.ts")>();
	return {
		...actual,
		resolveRepository: async (cwd: string) => {
			gate.entered++;
			await gate.wait;
			return actual.resolveRepository(cwd);
		},
	};
});

let workspace: Workspace;
let pika: FakePika;
let ui: RecordingUI;
let h: Harness;

beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start();
	pika.routes.set("GET memory", { body: { scopes: [USER_SCOPE, PROJECT_SCOPE], notes: [], index: "" } });
	serveDreams(pika);
	setCredentials(pika.url);
	resetDreams();
	ui = new RecordingUI();
	h = await startSession({ workspace, ui: ui.context() });
});
afterEach(async () => {
	gate.wait = undefined;
	currentDream()?.stop("stopped", "the test ended");
	await currentDream()?.done;
	await h.shutdown();
	resetDreams();
	await pika.stop();
	await workspace.cleanup();
});

it("input while the repository is resolved sends no lease request", async () => {
	const spawner = fakeSpawner();
	let open!: () => void;
	gate.wait = new Promise<void>((resolve) => { open = resolve; });
	const entered = gate.entered;
	const command = h.session.prompt("/memory dream");
	await until(() => gate.entered > entered, "the repository's resolution");
	await h.session.extensionRunner.emitInput("hello", undefined, "interactive");
	open();
	await command;
	expect(ui.notes.at(-1)!.message).toBe("pika memory: no dream: the user sent a message.");
	expect(leaseRequests(pika)).toEqual([]);
	expect(spawner.children).toEqual([]);
});

it("/memory status and /memory dream catch URL-embedded credentials in pre-flight", async () => {
	const spawner = fakeSpawner();
	setCredentials(pika.url.replace("http://", "http://alice:secret@"));
	const entered = gate.entered;
	const expected = "pika's server URL contains a user name or password; remove them from PIKA_URL or the url in pika.json";
	await h.session.prompt("/memory status");
	const status = ui.notes.at(-1)!;
	expect(status.message).toContain(`This session cannot dream: ${expected}.`);
	expect(status.message).not.toContain("alice");
	expect(status.message).not.toContain("secret");
	await h.session.prompt("/memory dream");
	const dream = ui.notes.at(-1)!;
	expect(dream).toEqual({ message: `pika memory: no dream: ${expected}.`, type: "warning" });
	expect(dream.message).not.toContain("alice");
	expect(dream.message).not.toContain("secret");
	expect(gate.entered).toBe(entered);
	expect(leaseRequests(pika)).toEqual([]);
	expect(spawner.children).toEqual([]);
});
