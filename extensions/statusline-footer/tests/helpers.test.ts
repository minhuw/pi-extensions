import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	compactionThresholdPct,
	footerSettingsPath,
	loadFooterMode,
	saveFooterMode,
} from "../settings.ts";
import {
	SWARM_BOARDS,
	summarizeSwarmBoard,
	watchSwarmBoard,
} from "../swarm-board.ts";

describe("settings: footer mode persistence", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), "statusline-footer-settings-"));
		process.env.PI_CODING_AGENT_DIR = path.join(tempRoot, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("resolves footerSettingsPath inside PI_CODING_AGENT_DIR", () => {
		expect(footerSettingsPath()).toBe(
			path.join(tempRoot, "agent", "statusline-footer.json"),
		);
	});

	it('returns "full" by default when settings file is missing', () => {
		expect(loadFooterMode()).toBe("full");
	});

	it('round-trips "compact", "off", and "full" cleanly', async () => {
		for (const mode of ["compact", "off", "full"] as const) {
			await saveFooterMode(mode);
			expect(loadFooterMode()).toBe(mode);
		}
		const files = readdirSync(path.join(tempRoot, "agent"));
		expect(files).toEqual(["statusline-footer.json"]);
	});

	it('falls back to "full" on corrupt JSON or unexpected shape', async () => {
		await saveFooterMode("compact");
		writeFileSync(footerSettingsPath(), "{not valid json", "utf8");
		expect(loadFooterMode()).toBe("full");

		writeFileSync(footerSettingsPath(), JSON.stringify({ mode: "minimal" }), "utf8");
		expect(loadFooterMode()).toBe("full");

		writeFileSync(footerSettingsPath(), "null", "utf8");
		expect(loadFooterMode()).toBe("full");
	});
});

describe("settings: compactionThresholdPct", () => {
	function makeMocks(options: {
		model?: { provider: string; id: string; contextWindow?: number } | undefined;
		usage?: { contextWindow: number; tokens?: number; percent?: number } | undefined;
		settings?: unknown;
		omitGetSettings?: boolean;
		throwOnGetSettings?: boolean;
	}) {
		const pi = (options.omitGetSettings
			? {}
			: {
					getSettings: () => {
						if (options.throwOnGetSettings) throw new Error("not ready");
						return options.settings;
					},
				}) as unknown as ExtensionAPI;

		const ctx = {
			model: options.model,
			getContextUsage: () => options.usage,
		} as unknown as ExtensionContext;

		return { pi, ctx };
	}

	it("uses default 16384 reserve tokens", () => {
		expect(DEFAULT_COMPACTION_RESERVE_TOKENS).toBe(16_384);
		const { pi, ctx } = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 200_000 },
			usage: { contextWindow: 200_000 },
			settings: {},
		});
		expect(compactionThresholdPct(pi, ctx)).toBeCloseTo(91.808, 6);
	});

	it("falls back to model.contextWindow when usage is unavailable", () => {
		const { pi, ctx } = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 200_000 },
			usage: undefined,
			settings: {},
		});
		expect(compactionThresholdPct(pi, ctx)).toBeCloseTo(91.808, 6);
	});

	it("applies custom compaction.reserveTokens", () => {
		const { pi, ctx } = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 200_000 },
			usage: { contextWindow: 200_000 },
			settings: { compaction: { reserveTokens: 40_000 } },
		});
		expect(compactionThresholdPct(pi, ctx)).toBeCloseTo(80, 6);
	});

	it('applies per-model override from compaction.modelOverrides["provider/id"]', () => {
		const { pi, ctx } = makeMocks({
			model: { provider: "openai", id: "gpt-5", contextWindow: 100_000 },
			usage: { contextWindow: 100_000 },
			settings: {
				compaction: {
					reserveTokens: 20_000,
					modelOverrides: {
						"openai/gpt-5": { reserveTokens: 10_000 },
						"anthropic/claude-opus-4-6": { reserveTokens: 30_000 },
					},
				},
			},
		});
		expect(compactionThresholdPct(pi, ctx)).toBeCloseTo(90, 6);
	});

	it("returns undefined when compaction.enabled is false", () => {
		const { pi, ctx } = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 200_000 },
			usage: { contextWindow: 200_000 },
			settings: { compaction: { enabled: false, reserveTokens: 16_384 } },
		});
		expect(compactionThresholdPct(pi, ctx)).toBeUndefined();
	});

	it("falls back to default 16384 when getSettings is missing or throws", () => {
		const missing = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 200_000 },
			usage: { contextWindow: 200_000 },
			omitGetSettings: true,
		});
		expect(compactionThresholdPct(missing.pi, missing.ctx)).toBeCloseTo(91.808, 6);

		const throwing = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 200_000 },
			usage: { contextWindow: 200_000 },
			throwOnGetSettings: true,
		});
		expect(compactionThresholdPct(throwing.pi, throwing.ctx)).toBeCloseTo(91.808, 6);
	});

	it("returns undefined when reserve >= contextWindow or contextWindow is missing/invalid", () => {
		const equal = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 16_384 },
			usage: { contextWindow: 16_384 },
			settings: {},
		});
		expect(compactionThresholdPct(equal.pi, equal.ctx)).toBeUndefined();

		const larger = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 8_192 },
			usage: { contextWindow: 8_192 },
			settings: {},
		});
		expect(compactionThresholdPct(larger.pi, larger.ctx)).toBeUndefined();

		const zeroWindow = makeMocks({
			model: { provider: "anthropic", id: "claude-opus-4-6", contextWindow: 0 },
			usage: { contextWindow: 0 },
			settings: {},
		});
		expect(compactionThresholdPct(zeroWindow.pi, zeroWindow.ctx)).toBeUndefined();

		const noWindow = makeMocks({
			model: undefined,
			usage: undefined,
			settings: {},
		});
		expect(compactionThresholdPct(noWindow.pi, noWindow.ctx)).toBeUndefined();
	});
});

describe("swarm-board: summarizeSwarmBoard and watchSwarmBoard", () => {
	type BoardEntry = {
		version: 1;
		sessionId: string;
		updatedAt: number;
		cards: Array<{ status: "todo" | "doing" | "blocked" | "done" | "failed" | "dropped" }>;
	};
	type Registry = {
		version: 1;
		boards: Map<string, BoardEntry>;
		listeners: Set<(board: BoardEntry) => void>;
	};

	const shared = globalThis as Record<symbol, Registry | undefined>;

	function ensureRegistry(): Registry {
		return (shared[SWARM_BOARDS] ??= {
			version: 1,
			boards: new Map(),
			listeners: new Set(),
		});
	}

	function publishBoard(
		sessionId: string,
		statuses: Array<"todo" | "doing" | "blocked" | "done" | "failed" | "dropped">,
	): void {
		const reg = ensureRegistry();
		const board: BoardEntry = {
			version: 1,
			sessionId,
			updatedAt: Date.now(),
			cards: statuses.map((status) => ({ status })),
		};
		reg.boards.set(sessionId, board);
		for (const listener of [...reg.listeners]) {
			listener(board);
		}
	}

	afterEach(() => {
		delete shared[SWARM_BOARDS];
	});

	it("returns undefined for missing registry, missing session, empty board, or dropped-only cards", () => {
		expect(summarizeSwarmBoard("s1")).toBeUndefined();
		// Read-only lookup must not lazily initialize the global registry.
		expect(shared[SWARM_BOARDS]).toBeUndefined();

		ensureRegistry();
		expect(summarizeSwarmBoard("s1")).toBeUndefined();

		publishBoard("s1", []);
		expect(summarizeSwarmBoard("s1")).toBeUndefined();

		publishBoard("s1", ["dropped", "dropped"]);
		expect(summarizeSwarmBoard("s1")).toBeUndefined();
	});

	it("summarizes counts and formats doing, blocked, failed, and done states", () => {
		publishBoard("s1", ["done", "done", "doing", "todo", "todo", "dropped"]);
		expect(summarizeSwarmBoard("s1")).toEqual({
			total: 6,
			done: 2,
			doing: 1,
			todo: 2,
			blocked: 0,
			failed: 0,
			dropped: 1,
			text: "swarm 2/5 · 1 doing",
		});

		publishBoard("s1", ["done", "blocked", "doing", "todo"]);
		expect(summarizeSwarmBoard("s1")).toEqual({
			total: 4,
			done: 1,
			doing: 1,
			todo: 1,
			blocked: 1,
			failed: 0,
			dropped: 0,
			text: "swarm 1/4 · 1 blocked",
		});

		publishBoard("s1", ["done", "failed", "doing", "todo"]);
		expect(summarizeSwarmBoard("s1")).toEqual({
			total: 4,
			done: 1,
			doing: 1,
			todo: 1,
			blocked: 0,
			failed: 1,
			dropped: 0,
			text: "swarm 1/4 · 1 failed",
		});

		publishBoard("s1", ["done", "blocked", "failed", "failed", "doing"]);
		expect(summarizeSwarmBoard("s1")).toEqual({
			total: 5,
			done: 1,
			doing: 1,
			todo: 0,
			blocked: 1,
			failed: 2,
			dropped: 0,
			text: "swarm 1/5 · 1 blocked · 2 failed",
		});

		publishBoard("s1", ["done", "done", "done"]);
		expect(summarizeSwarmBoard("s1")).toEqual({
			total: 3,
			done: 3,
			doing: 0,
			todo: 0,
			blocked: 0,
			failed: 0,
			dropped: 0,
			text: "swarm 3/3",
		});
	});

	it("watches only the matching sessionId and stops firing after unsubscribe", () => {
		const onChange = vi.fn();
		const unsubscribe = watchSwarmBoard("session-a", onChange);

		// Registry is initialized by watchSwarmBoard when absent.
		expect(shared[SWARM_BOARDS]).toBeDefined();
		expect(shared[SWARM_BOARDS]?.listeners.size).toBe(1);

		publishBoard("session-b", ["doing"]);
		expect(onChange).not.toHaveBeenCalled();

		publishBoard("session-a", ["doing"]);
		expect(onChange).toHaveBeenCalledTimes(1);

		publishBoard("session-a", ["done"]);
		expect(onChange).toHaveBeenCalledTimes(2);

		unsubscribe();
		expect(shared[SWARM_BOARDS]?.listeners.size).toBe(0);

		publishBoard("session-a", ["done", "todo"]);
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});
