import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionContext, ExtensionFactory, ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { timing } from "../../../memory/client.ts";
import memoryExtension from "../../../memory/index.ts";
import type { Note } from "../../../memory/format.ts";
import {
	callTool, recordSystem, setCredentials, startSession as startBaseSession, Workspace as BaseWorkspace, type Harness as BaseHarness, type WorkspaceOptions,
} from "../../support/runtime.ts";

export { callTool, setCredentials };

const DEFAULT_TIMING = { ...timing };
export const REMOTE = "git@github.com:me/widgets.git";
export const REPOSITORY = "https://github.com/me/widgets";
export const PROJECT = "my-project";

/** A temp directory holding the agent dir, session dir, and project cwd (a git repository with an origin) of one test. */
export class Workspace extends BaseWorkspace {
	static override async create(options: WorkspaceOptions & { git?: boolean } = {}): Promise<Workspace> {
		const workspace = await BaseWorkspace.create({
			prefix: "pi-memory-", project: PROJECT,
			onCleanup: () => { setCredentials(undefined); },
			...options,
		});
		if (options.git !== false) {
			execFileSync("git", ["init", "-q", workspace.cwd]);
			execFileSync("git", ["-C", workspace.cwd, "remote", "add", "origin", REMOTE]);
		}
		Object.assign(timing, DEFAULT_TIMING);
		return workspace;
	}
}

export interface Harness extends BaseHarness {
	/** The system prompt of every provider request, in order. */
	systems: string[];
	/** Runs one prompt the model answers with text, and returns the system prompt of its request. */
	run(prompt: string): Promise<string>;
	/** The session's `pika-memory` entries on the current branch. */
	pins(): unknown[];
}

/** A real pi session runtime with memory and the faux provider. */
export async function startSession(options: {
	workspace: Workspace; cwd?: string; mode?: ExtensionContext["mode"]; sessionManager?: SessionManager; extensions?: ExtensionFactory[]; bindAsChild?: boolean; memory?: boolean;
	/** The UI context the session binds with; default none. */
	ui?: ExtensionUIContext;
	/** The faux provider's model ids; default `test`. */
	models?: string[];
}): Promise<Harness> {
	const base = await startBaseSession({
		...options,
		provider: "memory-test",
		extensions: [...(options.memory === false ? [] : [memoryExtension]), ...(options.extensions ?? [])],
	});
	const systems: string[] = [];
	return {
		runtime: base.runtime, faux: base.faux, errors: base.errors, systems,
		get session() { return base.runtime.session; },
		async run(prompt) {
			const before = systems.length;
			base.faux.appendResponses([recordSystem(systems, () => fauxAssistantMessage("ok"))]);
			await base.runtime.session.prompt(prompt);
			expect(systems.length).toBe(before + 1);
			return systems.at(-1)!;
		},
		pins: () => base.runtime.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === "pika-memory" ? [entry.data] : []),
		shutdown: () => base.shutdown(),
	};
}

/** The `memory` section of a system prompt, or undefined. */
export function memorySection(system: string): string | undefined {
	return /<memory>\n([\s\S]*?)\n<\/memory>/.exec(system)?.[1];
}

let counter = 0;
/** A note as the server returns it. */
export function note(fields: Partial<Note> = {}): Note {
	counter++;
	return {
		id: `abcdef${String(counter).padStart(6, "0")}`, scope: { key: `repo:${REPOSITORY}`, kind: "project", label: PROJECT }, category: "project",
		title: `Title ${counter}`, hook: `Hook ${counter}`, body: `Body ${counter}`, provenance: "agent", revision: 1,
		createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", deletedAt: null, deviceId: "laptop", sessionId: "s-old",
		...fields,
	};
}

export const USER_SCOPE = { key: "user", kind: "user" as const, label: "user" };
export const PROJECT_SCOPE = { key: `repo:${REPOSITORY}`, kind: "project" as const, label: PROJECT };
