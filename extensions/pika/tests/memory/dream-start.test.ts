import { expect, it, vi } from "vitest";
import { fakeSpawner, leaseRequests, until, useDreamEnv } from "./support/dream.ts";
import { setCredentials } from "./support/runtime.ts";

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

const env = useDreamEnv({ session: true, beforeTeardown: () => { gate.wait = undefined; } });

it("input while the repository is resolved sends no lease request", async () => {
	const spawner = fakeSpawner();
	let open!: () => void;
	gate.wait = new Promise<void>((resolve) => { open = resolve; });
	const entered = gate.entered;
	const command = env.h.session.prompt("/memory dream");
	await until(() => gate.entered > entered, "the repository's resolution");
	await env.h.session.extensionRunner.emitInput("hello", undefined, "interactive");
	open();
	await command;
	expect(env.ui.notes.at(-1)!.message).toBe("pika memory: no dream: the user sent a message.");
	expect(leaseRequests(env.pika)).toEqual([]);
	expect(spawner.children).toEqual([]);
});

it("/memory status and /memory dream catch URL-embedded credentials in pre-flight", async () => {
	const spawner = fakeSpawner();
	setCredentials(env.pika.url.replace("http://", "http://alice:secret@"));
	const entered = gate.entered;
	const expected = "pika's server URL contains a user name or password; remove them from PIKA_URL or the url in pika.json";
	await env.h.session.prompt("/memory status");
	const status = env.ui.notes.at(-1)!;
	expect(status.message).toContain(`This session cannot dream: ${expected}.`);
	expect(status.message).not.toContain("alice");
	expect(status.message).not.toContain("secret");
	await env.h.session.prompt("/memory dream");
	const result = env.ui.notes.at(-1)!;
	expect(result).toEqual({ message: `pika memory: no dream: ${expected}.`, type: "warning" });
	expect(result.message).not.toContain("alice");
	expect(result.message).not.toContain("secret");
	expect(gate.entered).toBe(entered);
	expect(leaseRequests(env.pika)).toEqual([]);
	expect(spawner.children).toEqual([]);
});
