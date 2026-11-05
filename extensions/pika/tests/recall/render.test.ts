import { expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import recallExtension from "../../recall/index.ts";

/** The tools recall registers, without a pi runtime. */
function tools(): Map<string, ToolDefinition> {
	const registered = new Map<string, ToolDefinition>();
	recallExtension({ registerTool: (tool: ToolDefinition) => { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
	return registered;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const lines = (component: { render(width: number): string[] }) => component.render(200).map((line) => line.trimEnd()).join("\n");
const context = (args: unknown, isError = false) => ({ args, isError, state: {}, invalidate() {}, expanded: false, isPartial: false }) as never;

it("renders compact calls and results", () => {
	const { recall_search: search, recall_read: read } = Object.fromEntries(tools());
	expect(lines(search!.renderCall!({ query: "parser bug", scope: "project" }, theme, context({})))).toBe("recall_search \"parser bug\" · this project");
	expect(lines(read!.renderCall!({ sessionId: "s-1", seq: 41 }, theme, context({})))).toBe("recall_read s-1 · seq 41");
	const found = { content: [{ type: "text" as const, text: "[recall] …\n2 past sessions match" }], details: { sessionIds: ["a", "b"] } };
	expect(lines(search!.renderResult!(found, { expanded: false, isPartial: false }, theme, context({})))).toBe("2 past sessions");
	expect(lines(search!.renderResult!(found, { expanded: true, isPartial: false }, theme, context({})))).toBe("2 past sessions\n[recall] …\n2 past sessions match");
	const overview = { content: [{ type: "text" as const, text: "[recall] …\nSession s-1: \"Fix it\"\nmore" }], details: { sessionId: "s-1", turns: [0, 1, 2] } };
	expect(lines(read!.renderResult!(overview, { expanded: false, isPartial: false }, theme, context({})))).toBe("Session s-1: \"Fix it\" · turns 0–2");
	const { recall_herder: herder } = Object.fromEntries(tools());
	expect(lines(herder!.renderCall!({ scope: "project" }, theme, context({})))).toBe("recall_herder runs · this project");
	expect(lines(herder!.renderCall!({ runId: "r-1", fromEvent: 40 }, theme, context({})))).toBe("recall_herder r-1 · from event 40");
	const runs = { content: [{ type: "text" as const, text: "[recall] …\n1 Herder run" }], details: { limit: 10, runIds: ["r-1"] } };
	expect(lines(herder!.renderResult!(runs, { expanded: false, isPartial: false }, theme, context({})))).toBe("1 Herder run");
	const run = { content: [{ type: "text" as const, text: "[recall] …\nHerder run r-1: \"Add it\"\nmore" }], details: { runId: "r-1", events: [0, 1, 2] } };
	expect(lines(herder!.renderResult!(run, { expanded: false, isPartial: false }, theme, context({})))).toBe("Herder run r-1: \"Add it\" · events 0–2");
	const failed = { content: [{ type: "text" as const, text: "recall needs the pika extension logged in" }], details: {} };
	expect(lines(read!.renderResult!(failed, { expanded: false, isPartial: false }, theme, context({}, true)))).toBe("recall needs the pika extension logged in");
});
