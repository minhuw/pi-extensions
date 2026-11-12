import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "../src/nodes/contract";
import { RecentTerminals } from "../src/nodes/workspace/recent";

const info = (terminalId: string): TerminalInfo => ({ terminalId, title: "bash", cwd: "/home/me", cols: 80, rows: 24, pid: 7, createdAt: 1, argv: ["/bin/bash", "-l"] });

describe("the terminal the workspace header describes", () => {
	const terminals = [info("a"), info("b"), info("c")];

	it("is the pane on screen while a terminal has focus", () => {
		const recent = new RecentTerminals();
		expect(recent.shown("n1", "/p", "a", terminals)?.terminalId).toBe("a");
		expect(recent.shown("n1", "/p", "b", terminals)?.terminalId).toBe("b");
	});

	it("is the project's last focused pane while an editor or diff has focus", () => {
		const recent = new RecentTerminals();
		recent.shown("n1", "/p", "a", terminals);
		recent.shown("n1", "/p", "b", terminals);
		expect(recent.shown("n1", "/p", undefined, terminals)?.terminalId).toBe("b");
		// Asked again (a render repeated), the same answer.
		expect(recent.shown("n1", "/p", undefined, terminals)?.terminalId).toBe("b");
	});

	it("is none in a project where no pane had focus yet, whatever other projects and nodes saw", () => {
		const recent = new RecentTerminals();
		recent.shown("n1", "/p", "a", terminals);
		recent.shown("n2", "/q", "c", terminals);
		expect(recent.shown("n1", "/q", undefined, terminals)).toBeUndefined();
		expect(recent.shown("n2", "/p", undefined, terminals)).toBeUndefined();
	});

	it("is none once the node no longer lists the last focused pane", () => {
		const recent = new RecentTerminals();
		recent.shown("n1", "/p", "a", terminals);
		expect(recent.shown("n1", "/p", undefined, [info("b")])).toBeUndefined();
	});
});
