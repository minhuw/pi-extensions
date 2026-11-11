import { writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import footerExtension from "../../../statusline-footer/index.ts";
import { STATUS_KEY } from "../../src/config.ts";
import { openRun } from "../../src/run/store.ts";
import { createGitFixture } from "../support/git-fixture.ts";
import { until } from "../steps/harness.ts";
import { harness, VALID_GOAL } from "./harness.ts";

// The footer's asynchronous Git telemetry is unrelated to status rendering; keep fixture Git commands real.
vi.mock("node:child_process", async (importOriginal) => ({
	...await importOriginal<typeof import("node:child_process")>(),
	execFile: vi.fn(),
}));

it("shows live Herder verification in both footer layouts beside routine research and clears it afterwards", async () => {
	const fixture = createGitFixture();
	const h = harness({ cwd: fixture.dir });
	let footer: { render(width: number): string[]; dispose(): void } | undefined;
	let releaseVerify = () => {};
	let verification: Promise<unknown> | undefined;
	const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text };
	// The adapter keeps its RPC context for approval; the footer gets a TUI view of the same session and statuses.
	const footerCtx = {
		...h.ctx, mode: "tui", model: { id: "test-model", provider: "test", reasoning: false },
		isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => ({ percent: 25, tokens: 2500, contextWindow: 10_000 }),
		sessionManager: { ...h.ctx.sessionManager, getEntries: () => [], getLeafId: () => "leaf", getBranch: () => [] },
		ui: {
			...h.ctx.ui,
			setFooter: (factory: any) => {
				footer?.dispose();
				footer = factory?.({ requestRender: vi.fn() }, theme, {
					onBranchChange: () => () => {}, getGitBranch: () => "main", getExtensionStatuses: () => h.statuses,
				});
			},
		},
	} as unknown as ExtensionContext;
	footerExtension(h.pi);
	const footerShutdown = h.handlers.get("session_shutdown")!.at(-1)!;
	const render = async (mode: "full" | "compact", width = 160) => {
		await h.commands.get("footer").handler(mode, footerCtx);
		const rows = footer!.render(width);
		// Ignore the workspace path, which can itself contain the words being checked.
		return (mode === "full" ? rows.slice(0, -1) : rows).join("\n");
	};
	try {
		for (const handler of h.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, footerCtx);
		const started = await h.tool("herder_run", { action: "start", goal: "add a greeting to the CLI" });
		const run = openRun(fixture.commonDir, started.details.runId);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });

		const runtime = h.runtime();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const progress = runtime.launchProgress!;
		progress.activity({ key: "a", task: "T1", label: "a very long step description repeated repeatedly", stage: "gate unit", state: "running" });
		progress.activity({ key: "b", task: "T2", label: "another very long step description repeated repeatedly", state: "running" });
		progress.log("ready");
		progress.phase("next phase");
		let releaseCheck!: () => void;
		const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
		vi.spyOn(runtime, "check").mockImplementation(async (_request, _signal, report) => { report?.("checking unit"); await checkGate; return []; });
		const check = h.tool("herder_check", {});
		try {
			await until(() => (h.statuses.get(STATUS_KEY) ?? "").includes("checking unit"));
			for (const mode of ["full", "compact"] as const) {
				const rendered = await render(mode, 80);
				expect(rendered, `${mode} layout at 80 columns`).toContain("checking unit");
				expect(rendered, `${mode} layout at 80 columns`).toContain("2 steps");
				expect(rendered, `${mode} layout at 80 columns`).toContain("gate unit");
				expect(rendered, `${mode} layout at 80 columns`).toContain("log: ready");
			}
		} finally {
			releaseCheck();
			await check;
			runtime.launches[0]!.settle();
			await until(() => !(h.statuses.get(STATUS_KEY) ?? "").includes("2 steps"));
		}
		expect(h.statuses.get(STATUS_KEY)).not.toContain("log: ready");
		for (const mode of ["full", "compact"] as const) expect(await render(mode, 80)).not.toContain("log: ready");
		const originalVerify = runtime.verify.bind(runtime);
		const gate = new Promise<void>((resolve) => { releaseVerify = resolve; });
		let signalStarted!: () => void;
		const startedVerify = new Promise<void>((resolve) => { signalStarted = resolve; });
		vi.spyOn(runtime, "verify").mockImplementation(async () => {
			const result = originalVerify();
			signalStarted();
			await gate;
			return result;
		});
		h.ctx.ui.setStatus("autoresearch", "research 2/5");
		const pending: Promise<unknown> = h.tool("herder_verify", {});
		verification = pending;
		await Promise.race([startedVerify, pending.then(() => { throw new Error("Verification settled before the gate opened"); })]);
		expect(runtime.calls.at(-1)).toEqual(["verify"]);
		expect.soft(h.statuses.get(STATUS_KEY)).toMatch(/verif/i);
		for (const mode of ["full", "compact"] as const) {
			const rendered = await render(mode);
			expect.soft(rendered, `${mode} layout`).toMatch(/verif/i);
			if (mode === "full") expect(rendered).toContain("research 2/5");
		}

		releaseVerify();
		await expect(pending).resolves.toMatchObject({ details: { verdict: "met" } });
		const readyStatus = h.statuses.get(STATUS_KEY) ?? "";
		expect(readyStatus).toMatch(/herder/i);
		expect(readyStatus).not.toMatch(/verif/i);
		for (const mode of ["full", "compact"] as const) expect(await render(mode)).not.toMatch(/verif/i);

		await h.shutdown();
		expect(h.statuses.has(STATUS_KEY)).toBe(false);
		for (const mode of ["full", "compact"] as const) {
			const rendered = await render(mode);
			expect(rendered).not.toContain(readyStatus);
			expect(rendered).not.toMatch(/verif/i);
		}
	} finally {
		releaseVerify();
		if (verification) await Promise.allSettled([verification]);
		await h.shutdown();
		await footerShutdown({ reason: "quit" }, footerCtx);
		footer?.dispose();
		fixture.cleanup();
	}
});
