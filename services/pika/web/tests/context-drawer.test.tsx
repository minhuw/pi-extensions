import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageDialog } from "../src/components/MessageDialog";
import { ContextDrawer } from "../src/context/ContextDrawer";
import { detectShape, newMessageStart, normalizeRequest, systemSections, type PayloadShape } from "../src/context/payload";
import type { Entry, ModelRequest } from "../src/lib/types";
import { assistantMessage, entry, header, onlineSession, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp, renderWithApi } from "./support/render";
import {
	anthropicCachedPayloads,
	anthropicPayload,
	bedrockCachedPayloads,
	googlePayload,
	modelRequest,
	openAiChatPayload,
	openAiResponsesPayload,
	piContextPayload,
} from "./support/requests";
import { createFakeServer, type FakeSession } from "./support/server";

function withRequest(item: Entry, requestId: string): Entry {
	return { ...item, requestId };
}

function sessionWithRequests(): FakeSession {
	const entries = [
		entry(0, header("s1")),
		entry(1, userMessage("Fix the failing test")),
		withRequest(entry(2, assistantMessage([toolCall("toolu_1", "read", { path: "src/api.ts" })])), "r1"),
		entry(3, toolResultMessage("toolu_1", "read", "export const base = '/';")),
		withRequest(entry(4, assistantMessage([{ type: "text", text: "The base path is fine." }], 5000)), "r2"),
	];
	return { detail: summary("s1"), entries, turns: [turn(0, 1, 4, { userText: "Fix the failing test", modelCalls: 2, toolCalls: 1 })] };
}

function drawer(): HTMLElement {
	return document.querySelector<HTMLElement>("[data-context-drawer]")!;
}

function renderDrawer(request: ModelRequest, extraRequests: ModelRequest[] = []) {
	const server = createFakeServer({
		sessions: [{ detail: summary("s1"), entries: [entry(0, header("s1"))], turns: [] }],
		requests: [request, ...extraRequests],
	});
	renderWithApi(<ContextDrawer target={{ requestId: request.id, sessionId: "s1", seq: 5 }} onClose={() => undefined} />, server.fetch);
	return server;
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("what the model saw", () => {
	it("opens from a model call and highlights messages new since the previous request", async () => {
		const r1 = modelRequest("r1", { ...anthropicPayload, messages: anthropicPayload.messages.slice(0, 1) });
		const r2 = modelRequest("r2", anthropicPayload);
		const server = createFakeServer({ sessions: [sessionWithRequests()], requests: [r1, r2] });
		renderApp("/s/s1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: /2 model calls/ }));
		const buttons = await screen.findAllByRole("button", { name: "Show what the model saw" });
		expect(buttons).toHaveLength(2);
		fireEvent.click(buttons[1]);

		const panel = await screen.findByRole("dialog", { name: "What the model saw" });
		expect(await within(panel).findByText("Anthropic messages")).toBeTruthy();
		expect(within(panel).getByText("payload")).toBeTruthy();
		expect(within(panel).getByText("anthropic")).toBeTruthy();
		expect(within(panel).getByText("anthropic-messages")).toBeTruthy();
		expect(within(panel).getAllByText("claude-sonnet-4-5").length).toBeGreaterThan(0);
		expect(server.calls).toContain("/api/v1/requests/r2");

		// The previous request is found in the cached entries and compared by prefix.
		await waitFor(() => expect(panel.querySelector("[data-new-count]")?.getAttribute("data-new-count")).toBe("2"));
		expect(server.calls).toContain("/api/v1/requests/r1");
		const rows = [...panel.querySelectorAll("[data-context-message]")];
		expect(rows.map((row) => row.hasAttribute("data-new"))).toEqual([false, true, true]);

		// System prompt sections, tools, and the raw JSON view.
		expect(within(panel).getByText("You are an expert coding assistant.")).toBeTruthy();
		expect(panel.querySelector("[data-system-sections]")?.getAttribute("data-system-sections")).toBe("3");
		fireEvent.click(within(panel).getByRole("button", { name: /Project Context/ }));
		expect(within(panel).getByText("Use conventional commits.")).toBeTruthy();
		fireEvent.click(within(panel).getByRole("button", { name: "1 tool declaration" }));
		expect(within(panel).getByText("Read the contents of a file.", { selector: "span" })).toBeTruthy();
		expect(panel.querySelector("[data-raw-json]")).toBeNull();
		fireEvent.click(within(panel).getByRole("button", { name: /Show the reconstructed request/ }));
		expect(panel.querySelector("[data-raw-json] pre")?.textContent).toContain('"max_tokens": 32000');

		fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => expect(document.querySelector("[data-context-drawer]")).toBeNull());
	});

	it("leaves Escape to a message composer open above it", async () => {
		const request = modelRequest("r1", anthropicPayload);
		const server = createFakeServer({ sessions: [{ detail: summary("s1"), entries: [entry(0, header("s1"))], turns: [] }], requests: [request] });
		const closeDrawer = vi.fn();
		const closeDialog = vi.fn();
		function Composer() {
			const [open, setOpen] = useState(true);
			const onClose = () => {
				closeDialog();
				setOpen(false);
			};
			return open ? <MessageDialog session={onlineSession("s1", { name: "Alpha" })} onClose={onClose} /> : null;
		}
		renderWithApi(
			<>
				<ContextDrawer target={{ requestId: request.id, sessionId: "s1", seq: 5 }} onClose={closeDrawer} />
				<Composer />
			</>,
			server.fetch,
		);
		const text = within(screen.getByRole("dialog", { name: "Message Alpha" })).getByLabelText("Message text");
		fireEvent.change(text, { target: { value: "Hello" } });
		fireEvent.keyDown(text, { key: "Escape" });
		expect(closeDialog).not.toHaveBeenCalled();
		expect(closeDrawer).not.toHaveBeenCalled();
		fireEvent.change(text, { target: { value: "" } });
		fireEvent.keyDown(text, { key: "Escape" });
		expect(closeDialog).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("dialog", { name: "Message Alpha" })).toBeNull();
		expect(closeDrawer).not.toHaveBeenCalled();
		// Without the composer in the way, Escape is the drawer's.
		fireEvent.keyDown(screen.getByRole("dialog", { name: "What the model saw" }), { key: "Escape", bubbles: true });
		expect(closeDrawer).toHaveBeenCalledTimes(1);
	});

	const shapes: [string, ModelRequest, PayloadShape, string[]][] = [
		["Anthropic messages", modelRequest("ra", anthropicPayload), "anthropic-messages", ["user", "assistant", "user"]],
		[
			"OpenAI chat completions",
			modelRequest("rc", openAiChatPayload, { provider: "openai", api: "openai-completions", model: "gpt-5" }),
			"openai-chat",
			["user", "assistant", "tool"],
		],
		[
			"OpenAI responses",
			modelRequest("rr", openAiResponsesPayload, { provider: "openai", api: "openai-responses", model: "gpt-5-codex" }),
			"openai-responses",
			["user", "assistant", "assistant", "tool"],
		],
		[
			"Google contents",
			modelRequest("rg", googlePayload, { provider: "google", api: "google-generative-ai", model: "gemini-2.5-pro" }),
			"google",
			["user", "model", "user"],
		],
	];

	it.each(shapes)("renders %s payloads", async (label, request, shape, roles) => {
		expect(detectShape(request.payload, { api: request.api })).toBe(shape);
		renderDrawer(request);
		const panel = drawer();
		expect(await within(panel).findByText(label)).toBeTruthy();
		expect(within(panel).getByText("You are an expert coding assistant.")).toBeTruthy();
		const rows = [...panel.querySelectorAll<HTMLElement>("[data-context-message]")];
		expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual(roles);
		expect(within(rows[0]).getByText("Fix the failing test")).toBeTruthy();
		expect(panel.querySelector("[data-block='tool-call']")?.textContent).toContain("read");
		expect(panel.querySelector("[data-block='tool-call']")?.textContent).toContain('"path": "src/api.ts"');
		expect(panel.querySelector("[data-block='tool-result']")?.textContent).toContain("export const base = '/';");
		fireEvent.click(within(panel).getByRole("button", { name: "1 tool declaration" }));
		expect(panel.querySelector("[data-tool-decl='read']")?.textContent).toContain("Read the contents of a file.");
	});

	it("marks pi context captures", async () => {
		renderDrawer(modelRequest("rp", piContextPayload, { fidelity: "context", provider: "openai", api: "openai-responses" }));
		const panel = drawer();
		expect(await within(panel).findByText("pi context")).toBeTruthy();
		expect(within(panel).getByText("context", { selector: "span" })).toBeTruthy();
		expect(within(panel).getByText("pi context, not the provider payload")).toBeTruthy();
		expect(within(panel).getByText("You are an expert coding assistant.")).toBeTruthy();
		const roles = [...panel.querySelectorAll("[data-context-message]")].map((row) => row.querySelector("span")?.textContent);
		expect(roles).toEqual(["user", "assistant", "toolResult"]);
	});

	it("shows an incomplete notice and placeholders for missing blocks", async () => {
		const payload = { ...anthropicPayload, messages: [anthropicPayload.messages[0], { $pika: "ab".repeat(32) }] };
		renderDrawer(modelRequest("ri", payload, { complete: false }));
		const panel = drawer();
		expect(await within(panel).findByText("Incomplete request")).toBeTruthy();
		expect(within(panel).getByText("incomplete")).toBeTruthy();
		expect(panel.querySelector("[data-block='missing']")?.textContent).toContain("abababababab");
	});

	it("shows placeholders for a missing system prompt and tool declarations", async () => {
		const hash = (c: string) => c.repeat(64);
		const payload = { ...anthropicPayload, system: [{ $pika: hash("a") }], tools: [anthropicPayload.tools[0], { $pika: hash("b") }] };
		renderDrawer(modelRequest("rs", payload, { complete: false }));
		const panel = drawer();
		expect(await within(panel).findByText("Incomplete request")).toBeTruthy();
		const system = within(panel).getByRole("heading", { name: /System prompt/ }).closest("section")!;
		expect(system.querySelector("[data-block='missing']")?.textContent).toContain("aaaaaaaaaaaa");
		expect(within(system).queryByText("None")).toBeNull();
		fireEvent.click(within(panel).getByRole("button", { name: "2 tool declarations" }));
		expect(panel.querySelector("[data-tool-decl='read']")).toBeTruthy();
		const tools = within(panel).getByRole("heading", { name: /Tools/ }).closest("section")!;
		expect(tools.querySelector("[data-block='missing']")?.textContent).toContain("bbbbbbbbbbbb");
		expect(tools.querySelectorAll("[data-tool-decl]")).toHaveLength(1);
	});

	it("shows a placeholder for long OpenAI instructions that are not uploaded yet", () => {
		const hash = "c".repeat(64);
		const normal = normalizeRequest({ ...openAiResponsesPayload, instructions: { $pika: hash, $type: "string" } }, { api: "openai-responses" });
		expect(normal.system).toBeNull();
		expect(normal.systemMissing).toEqual([hash]);
		expect(normal.settings).not.toHaveProperty("instructions");
		const pi = normalizeRequest({ ...piContextPayload, systemPrompt: { $pika: hash, $type: "string" } }, { fidelity: "context" });
		expect(pi.systemMissing).toEqual([hash]);
		expect(pi.system).toContain("expert coding assistant");
	});

	it("refetches an incomplete request when the drawer opens again", async () => {
		const r1 = modelRequest("r1", { ...anthropicPayload, messages: anthropicPayload.messages.slice(0, 1) });
		const r2 = modelRequest("r2", { ...anthropicPayload, messages: [anthropicPayload.messages[0], { $pika: "ab".repeat(32) }] }, { complete: false });
		const server = createFakeServer({ sessions: [sessionWithRequests()], requests: [r1, r2] });
		renderApp("/s/s1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: /2 model calls/ }));
		const open = async () => {
			fireEvent.click((await screen.findAllByRole("button", { name: "Show what the model saw" }))[1]);
			return screen.findByRole("dialog", { name: "What the model saw" });
		};
		const close = async () => {
			fireEvent.keyDown(window, { key: "Escape" });
			await waitFor(() => expect(document.querySelector("[data-context-drawer]")).toBeNull());
		};
		expect(await within(await open()).findByText("Incomplete request")).toBeTruthy();
		await close();

		// The device uploads the missing block; the server now reconstructs the full request.
		Object.assign(r2, { payload: anthropicPayload, complete: true });
		let panel = await open();
		await waitFor(() => expect(within(panel).queryByText("Incomplete request")).toBeNull());
		expect(panel.querySelector("[data-block='missing']")).toBeNull();
		expect(server.calls.filter((call) => call === "/api/v1/requests/r2")).toHaveLength(2);
		await close();

		// Complete requests are not fetched again.
		panel = await open();
		expect(await within(panel).findByText("Anthropic messages")).toBeTruthy();
		expect(server.calls.filter((call) => call === "/api/v1/requests/r2")).toHaveLength(2);
	});

	it("falls back to a JSON tree for unknown payloads", async () => {
		renderDrawer(modelRequest("rx", { prompt: "hello", options: { n: 1 } }, { api: "mystery" }));
		const panel = drawer();
		expect(await within(panel).findByText("Unrecognized payload")).toBeTruthy();
		expect(panel.querySelector("[data-json-tree]")?.textContent).toContain("hello");
	});

	it("virtualizes a 2,000-message request", async () => {
		restore();
		restore = mockLayout({ viewport: 800, rowHeight: 100 });
		const messages = Array.from({ length: 2000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Message ${i}` }));
		renderDrawer(modelRequest("rv", { ...anthropicPayload, messages }));
		const panel = drawer();
		expect(await within(panel).findByText("Message 0")).toBeTruthy();
		const count = () => panel.querySelectorAll("[data-context-message]").length;
		expect(count()).toBeGreaterThan(0);
		expect(count()).toBeLessThan(40);

		const pane = panel.querySelector<HTMLElement>("[data-scroll-pane]")!;
		await act(async () => {
			pane.scrollTop = 100_000;
			pane.dispatchEvent(new Event("scroll"));
		});
		const indices = () => [...panel.querySelectorAll("[data-context-message]")].map((row) => Number(row.getAttribute("data-context-message")));
		await waitFor(() => expect(Math.min(...indices())).toBeGreaterThan(800));
		expect(within(panel).queryByText("Message 0")).toBeNull();
		expect(within(panel).getByText(`Message ${indices()[0]}`)).toBeTruthy();
		expect(count()).toBeLessThan(40);
	});
});

describe("payload normalization", () => {
	it("pulls leading system messages into the system prompt", () => {
		const normal = normalizeRequest(openAiChatPayload, { api: "openai-completions" });
		expect(normal.system).toContain("expert coding assistant");
		expect(normal.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
		expect(normal.settings).toEqual({ model: "gpt-5", stream: true });
	});

	it("keeps Google config settings but not the system instruction or tools", () => {
		const normal = normalizeRequest(googlePayload, {});
		expect(normal.tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(normal.settings).toEqual({ model: "gemini-2.5-pro", config: { temperature: 0.2 } });
	});

	it("splits system prompts into tag and heading sections", () => {
		expect(systemSections("Intro\n<rules>\n- be concise\n</rules>\n# Context\nrepo notes\n```\n# not a heading\n```")).toEqual([
			{ title: "", text: "Intro" },
			{ title: "rules", text: "- be concise" },
			{ title: "Context", text: "repo notes\n```\n# not a heading\n```" },
		]);
	});

	it("counts new messages after the longest common prefix", () => {
		const a = normalizeRequest(anthropicPayload, {}).messages;
		expect(newMessageStart(a, a.slice(0, 1))).toBe(1);
		expect(newMessageStart(a, a)).toBe(3);
		expect(newMessageStart(a, undefined)).toBeUndefined();
	});

	it("ignores moved Anthropic cache_control markers when counting new messages", () => {
		const { first, second, third } = anthropicCachedPayloads;
		const messages = (payload: unknown) => normalizeRequest(payload, { api: "anthropic-messages" }).messages;
		expect(newMessageStart(messages(second), messages(first))).toBe(1);
		expect(newMessageStart(messages(third), messages(second))).toBe(3);
		// A changed message still ends the common prefix.
		const edited = { ...third, messages: [{ role: "user", content: "Fix the other test" }, ...third.messages.slice(1)] };
		expect(newMessageStart(messages(edited), messages(second))).toBe(0);
	});

	it("ignores moved Bedrock cachePoint elements when counting new messages", () => {
		const { first, second } = bedrockCachedPayloads;
		const messages = (payload: unknown) => normalizeRequest(payload, { api: "bedrock-converse-stream" }).messages;
		expect(detectShape(second, { api: "bedrock-converse-stream" })).toBe("anthropic-messages");
		expect(newMessageStart(messages(second), messages(first))).toBe(1);
		const edited = { ...second, messages: [{ role: "user", content: [{ text: "Fix the other test" }] }, ...second.messages.slice(1)] };
		expect(newMessageStart(messages(edited), messages(first))).toBe(0);
	});
});
