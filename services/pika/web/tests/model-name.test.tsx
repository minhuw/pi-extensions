import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelName, modelMaker } from "../src/components/ModelName";
import { bareModel, bareModelOf } from "../src/lib/model";
import { buildTimeline } from "../src/session/timeline";
import type { TraceRecord } from "../src/lib/types";
import { KindBadge, KindBullet } from "../src/trace/parts";

describe("bare model names", () => {
	it.each([
		["codex/gpt-6.1-sol", "gpt-6.1-sol"],
		["auto/claude-opus-5-5", "claude-opus-5-5"],
		["mercerrouter/claude-opus-5-5", "claude-opus-5-5"],
		["claude/claude-opus-5-5", "claude-opus-5-5"],
		["deepseek/deepseek-flash", "deepseek-flash"],
		["kimi/k3.1-pro", "k3.1-pro"],
		["grok/grok-4.7", "grok-4.7"],
		["grok-4.7@500k", "grok-4.7"],
		["google/gemini-3.5-flash", "gemini-3.5-flash"],
		["magpie/codex/gpt-6-luna", "gpt-6-luna"],
		["gpt-6.1-sol", "gpt-6.1-sol"],
		["  codex/ gpt-6.1-sol  ", "gpt-6.1-sol"],
		["model@a@b", "model"],
		// Nothing would be left: the id stays, trimmed.
		["codex/", "codex/"],
		[" @500k ", "@500k"],
		["a/@x", "a/@x"],
		["", ""],
	])("names %j %j, as the server does", (id, bare) => {
		expect(bareModel(id)).toBe(bare);
		expect(bareModel(bareModel(id))).toBe(bare);
	});

	it("treats a missing or blank id as no model", () => {
		expect(bareModelOf(undefined)).toBeUndefined();
		expect(bareModelOf(42)).toBeUndefined();
		expect(bareModelOf("  ")).toBeUndefined();
		expect(bareModelOf("auto/claude-opus-5-5")).toBe("claude-opus-5-5");
	});

	it("notes a model switch by the bare model, without the provider", () => {
		const raw = (modelId?: string) => ({ type: "model_change", id: "m", parentId: null, timestamp: "2026-10-20T09:00:00.000Z", provider: "magpie", modelId });
		const notes = buildTimeline([
			{ seq: 1, offset: 0, id: "m", type: "model_change", timestamp: "2026-10-20T09:00:00.000Z", raw: raw("codex/gpt-6.1-sol@1m") },
			{ seq: 2, offset: 1, id: "n", type: "model_change", timestamp: "2026-10-20T09:00:00.000Z", raw: raw() },
		] as never).map((item) => (item.kind === "note" ? item.text : item.kind));
		expect(notes).toEqual(["Switched model to gpt-6.1-sol", "Switched model"]);
	});
});

describe("model names", () => {
	it.each([
		["gpt-6-astra", "openai"],
		["codex/gpt-6.1-sol", "openai"],
		["magpie/codex/gpt-6-luna", "openai"],
		["openai/gpt-6", "openai"],
		["o3-mini", "openai"],
		["claude-opus-5-5", "claude"],
		["mercerrouter/claude-opus-5-5", "claude"],
		["auto/claude-fable-5", "claude"],
		["gemini-3.7-flash-high", "gemini"],
		["grok-4.7@500k", "grok"],
		["grok/grok-4.7", "grok"],
		["deepseek/deepseek-flash", "deepseek"],
		["deepseek-v4-pro", "deepseek"],
		["kimi-k3", "kimi"],
		["k3.1-pro", "kimi"],
		["kimi/k3.1-pro", "kimi"],
		["k3", "kimi"],
	])("knows who makes %s", (model, maker) => {
		expect(modelMaker(model)).toBe(maker);
	});

	it.each(["test", "mock-model", "local", "openrouter/auto", "kilo-7b", "omni", "claude/omni", "gpt/local"])("leaves %s without a maker", (model) => {
		expect(modelMaker(model)).toBeUndefined();
	});

	it("puts the maker's mark after the name, hidden from assistive technology, and names the maker on hover", () => {
		render(<ModelName model="mercerrouter/claude-opus-5-5" />);
		const name = screen.getByText("mercerrouter/claude-opus-5-5");
		const label = name.parentElement!;
		expect(label.title).toBe("mercerrouter/claude-opus-5-5, by Anthropic");
		expect(label.className).toContain("text-model-claude");
		const mark = label.querySelector("svg")!;
		expect(mark.getAttribute("data-model-mark")).toBe("claude");
		expect(mark.getAttribute("aria-hidden")).toBe("true");
		expect(name.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("gives each Gemini mark its own gradients", () => {
		render(<><ModelName model="gemini-3.7-flash-high" /><ModelName model="gemini-2.5-pro" /></>);
		const ids = [...document.querySelectorAll("linearGradient")].map((gradient) => gradient.id);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
		for (const id of ids) expect(id).toMatch(/^[\w-]+$/);
		const fills = [...document.querySelectorAll("[data-model-mark='gemini'] path")].map((path) => path.getAttribute("fill"));
		for (const id of ids) expect(fills).toContain(`url(#${id})`);
	});

	it("keeps a model it doesn't know as plain text", () => {
		render(<ModelName model="mock-model" />);
		const name = screen.getByText("mock-model");
		expect(name.querySelector("svg")).toBeNull();
		expect(name.title).toBe("");
	});
});

describe("kind bullets", () => {
	const llm = (model?: string): TraceRecord => ({ kind: "llm", seq: 1, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }) as TraceRecord;
	const tool = (name: string): TraceRecord => ({ kind: "tool", seq: 1, callId: "c1", name, isError: false }) as TraceRecord;
	const bullet = () => document.querySelector<HTMLElement>("[data-bullet]")!;

	it("shows a model call as its maker's own logo in the maker's colours, and one pika doesn't know as a sparkle bullet", () => {
		render(<KindBadge record={llm("claude-opus-5-5")} />);
		expect(bullet().dataset.bullet).toBe("llm");
		expect(bullet().className).not.toContain("bg-k-llm");
		expect(bullet().querySelector("[data-model-mark='claude'] path")?.getAttribute("fill")).toBe("#D97757");
		cleanup();

		render(<KindBadge record={llm("deepseek-flash")} />);
		expect(bullet().querySelector("[data-model-mark='deepseek'] path")?.getAttribute("fill")).toBe("#4D6BFE");
		cleanup();
		// OpenAI's mark is black and white: it takes the ink colour, so it turns white in the dark theme.
		render(<KindBadge record={llm("codex/gpt-6-luna")} />);
		expect(bullet().className).toContain("text-ink");
		expect(bullet().querySelector("[data-model-mark='openai'] path")?.getAttribute("fill")).toBe("currentColor");
		cleanup();

		render(<KindBadge record={llm("mock-model")} />);
		expect(bullet().className).toContain("bg-k-llm");
		expect(bullet().querySelector("[data-model-mark]")).toBeNull();
		expect(bullet().querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe("model");
	});

	it("keeps a failed model call's red bullet, with the maker's logo in its ink", () => {
		render(<KindBadge record={{ ...llm("claude-opus-5-5"), error: "overloaded" } as TraceRecord} />);
		expect(bullet().className).toContain("bg-k-error");
		expect(bullet().querySelector("[data-model-mark='claude'] path")?.getAttribute("fill")).toBe("currentColor");
	});

	it.each([
		["bash", "shell"],
		["read", "read"],
		["grep", "search"],
		["ls", "list"],
		["web_fetch", "web"],
		["edit", "edit"],
		["write", "write"],
		["Agent", "agent"],
		["SubagentWorkflow", "workflow"],
		["mcp__github__create_issue", "mcp"],
		["todo_write", "tool"],
	])("gives a %s call the %s glyph", (name, glyph) => {
		render(<KindBadge record={tool(name)} />);
		expect(bullet().querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe(glyph);
	});

	it("shows a family's own glyph without a record, and keeps it red when the record failed", () => {
		render(<KindBullet family="agent" error />);
		expect(bullet().querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe("agent");
		expect(bullet().className).toContain("bg-k-error");
		expect(bullet().title).toBe("Subagent");
	});
});
