import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolCall, ToolResultMessage } from "../src/lib/types";
import { ToolView } from "../src/session/TimelineItemView";
import { findToolRenderer, parseToolName, registerToolRenderer } from "../src/session/tools/registry";
import { extractLinks } from "../src/session/tools/web";
import { summary, toolCall, toolResultMessage } from "./support/fixtures";
import { renderInSession } from "./support/render";

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return toolCall(id, name, args) as ToolCall;
}

function result(...args: Parameters<typeof toolResultMessage>): ToolResultMessage {
	return toolResultMessage(...args).message as ToolResultMessage;
}

function tool(container: HTMLElement, id: string): HTMLElement {
	const node = container.querySelector<HTMLElement>(`[data-tool="${id}"]`);
	if (!node) throw new Error(`no ${id} tool rendered`);
	return node;
}

describe("tool renderer registry", () => {
	it("matches built-in, MCP, and unknown tool names", () => {
		expect(parseToolName("mcp__exa__web_search_exa")).toEqual({ full: "mcp__exa__web_search_exa", base: "web_search_exa", server: "exa" });
		expect(findToolRenderer("bash").id).toBe("bash");
		expect(findToolRenderer("read").id).toBe("read");
		expect(findToolRenderer("edit").id).toBe("edit");
		expect(findToolRenderer("write").id).toBe("write");
		expect(findToolRenderer("codemode").id).toBe("codemode");
		expect(findToolRenderer("web_search").id).toBe("web");
		expect(findToolRenderer("web_fetch").id).toBe("web");
		expect(findToolRenderer("fetch_content").id).toBe("web");
		expect(findToolRenderer("mcp__exa__web_search_exa").id).toBe("web");
		expect(findToolRenderer("mcp__brave-search__brave_web_search").id).toBe("web");
		expect(findToolRenderer("mcp__fetch__fetch").id).toBe("web");
		expect(findToolRenderer("mcp__github__create_issue").id).toBe("generic");
		expect(findToolRenderer("Agent").id).toBe("agent");
		expect(findToolRenderer("mcp__tools__read").id).toBe("read");
		expect(findToolRenderer("grep").id).toBe("generic");
	});

	it("lets later views register renderers that take precedence", () => {
		const unregister = registerToolRenderer({
			id: "custom-agent",
			icon: "agent",
			match: (name) => name.base === "Agent",
			Component: () => <div>custom</div>,
		});
		expect(findToolRenderer("Agent").id).toBe("custom-agent");
		unregister();
		expect(findToolRenderer("Agent").id).toBe("agent");
	});
});

describe("tool renderers", () => {
	it("bash: command, output, exit status, and truncation note", () => {
		const { container } = renderInSession(
			<ToolView
				call={call("call_1", "bash", { command: "npm test -- --run", timeout: 120 })}
				result={result("call_1", "bash", "✓ 42 tests passed\n\n[Showing lines 1-2000 of 4000]", {
					details: { truncation: { truncated: true, totalLines: 4000, outputLines: 2000 }, fullOutputPath: "/tmp/pi-bash-1.log" },
				})}
			/>,
		);
		const node = tool(container, "bash");
		expect(within(node).getByText("npm test -- --run", { selector: "code" })).toBeTruthy();
		expect(within(node).getByText(/42 tests passed/)).toBeTruthy();
		expect(within(node).getByText("exit 0")).toBeTruthy();
		expect(within(node).getByText(/showing 2k of 4k lines; full output in \/tmp\/pi-bash-1.log/)).toBeTruthy();
		expect(within(node).getByText("timeout 120s")).toBeTruthy();
	});

	it("bash: a failing command shows its exit code in an error callout", () => {
		const { container } = renderInSession(
			<ToolView
				call={call("call_2", "bash", { command: "cargo build" })}
				result={result("call_2", "bash", "error[E0425]: cannot find value `x`\n\nCommand exited with code 101", { isError: true })}
			/>,
		);
		const callout = within(tool(container, "bash")).getByRole("alert");
		expect(within(callout).getByText("Exited with code 101")).toBeTruthy();
		expect(within(callout).getByText(/cannot find value/)).toBeTruthy();
		expect(within(callout).queryByText(/Command exited with code/)).toBeNull();
	});

	it("read: path, line range, and highlighted content", async () => {
		const { container } = renderInSession(
			<ToolView
				call={call("call_3", "read", { path: "src/lib/api.ts", offset: 10, limit: 20 })}
				result={result("call_3", "read", "export const answer = 42;\nconst name = \"pika\";")}
			/>,
		);
		const node = tool(container, "read");
		expect(within(node).getAllByText("src/lib/api.ts").length).toBeGreaterThan(0);
		expect(within(node).getByText("lines 10–29")).toBeTruthy();
		await waitFor(() => expect(node.querySelector(".hljs-keyword")).not.toBeNull());
		expect(node.querySelector("pre")?.getAttribute("data-language")).toBe("typescript");
	});

	it("edit: a unified diff of each oldText → newText edit", () => {
		const { container } = renderInSession(
			<ToolView
				call={call("call_4", "edit", {
					path: "src/app.ts",
					edits: [
						{ oldText: "const a = 1;\nconst b = 2;\nconst c = 3;", newText: "const a = 1;\nconst b = 20;\nconst c = 3;" },
						{ oldText: "log(a);", newText: "log(a);\nlog(b);" },
					],
				})}
				result={result("call_4", "edit", "Successfully replaced 2 block(s) in src/app.ts.")}
			/>,
		);
		const node = tool(container, "edit");
		expect(node.querySelectorAll("[data-diff]").length).toBe(2);
		const deleted = [...node.querySelectorAll('[data-diff-line="del"]')].map((line) => line.textContent);
		const added = [...node.querySelectorAll('[data-diff-line="add"]')].map((line) => line.textContent);
		expect(deleted).toEqual(["-const b = 2;"]);
		expect(added).toEqual(["+const b = 20;", "+log(b);"]);
		expect(within(node).getByText("2 edits · +2 −1")).toBeTruthy();
	});

	it("write: path, then collapsed content", () => {
		const { container } = renderInSession(
			<ToolView
				call={call("call_5", "write", { path: "notes/todo.md", content: "# Todo\n\n- ship pika\n" })}
				result={result("call_5", "write", "Successfully wrote 22 bytes to notes/todo.md")}
			/>,
		);
		const node = tool(container, "write");
		expect(within(node).getAllByText("notes/todo.md").length).toBeGreaterThan(0);
		expect(within(node).queryByText(/ship pika/)).toBeNull();
		fireEvent.click(within(node).getByRole("button", { name: /Content · 3 lines/ }));
		expect(within(node).getByText(/ship pika/)).toBeTruthy();
	});

	it("codemode: JavaScript source, then its output", () => {
		const code = 'const r = await tools.bash({ command: "ls" });\ntext(r.output);';
		const { container } = renderInSession(
			<ToolView
				call={call("call_6", "codemode", { code })}
				result={result("call_6", "codemode", "Script completed in 0.4s\nREADME.md\npackage.json")}
			/>,
		);
		const node = tool(container, "codemode");
		expect(node.querySelector('pre[data-language="javascript"]')?.textContent).toBe(code);
		expect(within(node).getByText(/Script completed in 0.4s/)).toBeTruthy();
	});

	it("web_search: link cards from the result", () => {
		const text = [
			"1. Vite documentation",
			"https://vite.dev/guide/",
			"",
			"See also [TanStack Virtual](https://tanstack.com/virtual/latest) and https://example.com/a.",
		].join("\n");
		const { container } = renderInSession(
			<ToolView call={call("call_7", "web_search", { query: "vite virtual list" })} result={result("call_7", "web_search", text)} />,
		);
		const node = tool(container, "web");
		expect(within(node).getByText("vite virtual list", { selector: "span.font-medium" })).toBeTruthy();
		const cards = [...node.querySelectorAll<HTMLAnchorElement>("[data-link-card]")];
		expect(cards.map((card) => card.getAttribute("href"))).toEqual([
			"https://tanstack.com/virtual/latest",
			"https://vite.dev/guide/",
			"https://example.com/a",
		]);
		expect(within(node).getByText("Vite documentation")).toBeTruthy();
		expect(within(node).getByText("TanStack Virtual")).toBeTruthy();
		expect(cards[0].getAttribute("rel")).toContain("noopener");
	});

	it("fetch_content and MCP web tools: the fetched URL as a card", () => {
		const { container } = renderInSession(
			<>
				<ToolView call={call("call_8", "fetch_content", { url: "https://docs.rs/rusqlite" })} result={result("call_8", "fetch_content", "# rusqlite\nErgonomic bindings")} />
				<ToolView
					call={call("call_9", "mcp__exa__web_search_exa", { query: "zstd rust" })}
					result={result("call_9", "mcp__exa__web_search_exa", "Title: zstd crate\nURL: https://crates.io/crates/zstd")}
				/>
			</>,
		);
		const cards = [...container.querySelectorAll<HTMLAnchorElement>("[data-link-card]")].map((card) => card.getAttribute("href"));
		expect(cards).toEqual(["https://docs.rs/rusqlite", "https://crates.io/crates/zstd"]);
		expect(screen.getByText("zstd crate")).toBeTruthy();
	});

	it("Agent: card with type, description, model, status, tokens, duration, and child link", () => {
		const child = { ...summary("child-1", { parentSessionId: "s1" }), parentToolCallId: "call_10" };
		const { container } = renderInSession(
			<ToolView
				call={call("call_10", "Agent", { subagent_type: "recon", description: "Map the ingest code", prompt: "Find where batches are applied." })}
				result={result("call_10", "Agent", "Batches are applied in `ingest.rs`.", {
					details: {
						displayName: "Recon",
						description: "Map the ingest code",
						subagentType: "recon",
						toolUses: 12,
						tokens: "48.2k",
						durationMs: 95_000,
						status: "completed",
						modelName: "anthropic/claude-haiku-4-5",
					},
				})}
			/>,
			{ childrenByToolCall: new Map([["call_10", child]]) },
		);
		const card = container.querySelector<HTMLElement>("[data-agent-card]")!;
		expect(within(card).getByText("recon")).toBeTruthy();
		expect(within(card).getByText("Map the ingest code")).toBeTruthy();
		expect(within(card).getByText("anthropic/claude-haiku-4-5")).toBeTruthy();
		expect(within(card).getByText("completed")).toBeTruthy();
		expect(within(card).getByText("48.2k tokens")).toBeTruthy();
		expect(within(card).getByText("1m 35s")).toBeTruthy();
		expect(within(card).getByText("12 tool uses")).toBeTruthy();
		expect(within(card).getByRole("link", { name: /Open session/ }).getAttribute("href")).toBe("/s/child-1");
	});

	it("unknown tools: pretty JSON arguments and the text result", () => {
		const { container } = renderInSession(
			<ToolView call={call("call_11", "grep", { pattern: "TODO", path: "src" })} result={result("call_11", "grep", "src/a.ts:3: // TODO")} />,
		);
		const node = tool(container, "generic");
		expect(node.querySelector('pre[data-language="json"]')?.textContent).toBe('{\n  "pattern": "TODO",\n  "path": "src"\n}');
		expect(within(node).getByText("src/a.ts:3: // TODO")).toBeTruthy();
	});

	it("tool errors are callouts", () => {
		const { container } = renderInSession(
			<ToolView call={call("call_12", "read", { path: "missing.txt" })} result={result("call_12", "read", "ENOENT: no such file", { isError: true })} />,
		);
		const callout = within(tool(container, "read")).getByRole("alert");
		expect(within(callout).getByText("ENOENT: no such file")).toBeTruthy();
	});

	it("shows a missing result and collapses from the header", () => {
		const { container } = renderInSession(<ToolView call={call("call_13", "bash", { command: "sleep 1" })} />);
		const node = tool(container, "bash");
		expect(within(node).getByText("No result recorded")).toBeTruthy();
		fireEvent.click(within(node).getAllByRole("button")[0]);
		expect(within(node).queryByText("No result recorded")).toBeNull();
	});
});

describe("extractLinks", () => {
	it("dedupes and strips trailing punctuation", () => {
		expect(extractLinks({ urls: ["https://a.dev/x"] }, "see https://a.dev/x. and https://b.dev,")).toEqual([
			{ url: "https://a.dev/x", title: undefined },
			{ url: "https://b.dev", title: undefined },
		]);
	});
});
