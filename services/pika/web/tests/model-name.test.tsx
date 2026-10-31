import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelName, modelMaker } from "../src/components/ModelName";

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

	it.each(["test", "mock-model", "local", "openrouter/auto", "kilo-7b", "omni"])("leaves %s without a maker", (model) => {
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
