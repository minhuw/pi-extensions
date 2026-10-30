import * as fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { liveSession } from "../support/live-session.ts";
import { hookStatus } from "../../src/project.ts";
import type { DetectorFeedback } from "../../src/detector.ts";
import { sha256 } from "../../src/engine.ts";
import { exec, type foundations } from "./foundations.ts";

export type Foundation = Awaited<ReturnType<typeof foundations>>;
export const product = "# Product\n\n## Platform\nweb\n\n## Audience\nLibrary visitors\n\n## Purpose\nFind opening hours and available books.\n";
export async function project(f: Foundation, name = "project") {
	const root = path.join(f.temp, name);
	await fs.mkdir(root);
	for (const [file, text] of Object.entries({ "package.json": '{"name":"disposable-library-ui","private":true}', "PRODUCT.md": product, "DESIGN.md": "# Visual authority\nNo direction selected.\n", "surface-brief.md": "# Library index\nAwait a direction decision.\n", "page.html": "<!doctype html><html><head><title>Library</title></head><body><main>Library hours</main></body></html>\n" })) await fs.writeFile(path.join(root, file), text);
	await exec("git", ["init", "--quiet"], { cwd: root, env: f.env });
	await exec("git", ["add", "package.json", "PRODUCT.md", "DESIGN.md", "surface-brief.md", "page.html"], { cwd: root, env: f.env });
	expect((await exec("git", ["ls-files"], { cwd: root, env: f.env })).stdout.trim().split("\n")).toHaveLength(5);
	const hashes: Record<string, string> = {};
	for (const file of ["package.json", "PRODUCT.md", "DESIGN.md", "surface-brief.md", "page.html"]) hashes[file] = sha256(await fs.readFile(path.join(root, file)));
	f.receipt[`fixtureSources:${name}`] = hashes; await f.save();
	return root;
}

export async function detectorPhase(f: Foundation, root: string) {
	const auditPath = path.join(f.artifacts, "native-hook-audit.ndjson");
	vi.stubEnv("IMPECCABLE_HOOK_LOG", auditPath);
	const runtime = await liveSession(root, undefined, undefined, true, f.env.PI_CODING_AGENT_DIR!);
	const feedback = () => runtime.session.sessionManager.getEntries().flatMap((entry) => entry.type === "custom_message" && entry.customType === "impeccable-detector" ? (entry.details as { feedback: DetectorFeedback[] }).feedback : []);
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)]);
	const bad = '<!doctype html><html><head><title>Library</title><style>body { font-family: Inter, sans-serif; }</style></head><body><main><h1>Library hours</h1><p>Find books and opening times.</p></main></body></html>\n';
	try {
		expect((await hookStatus(root)).enabled).toBe(false);
		runtime.faux.setResponses([call("write", { path: "page.html", content: bad }), call("edit", { path: "page.html", edits: [{ oldText: "Inter", newText: "Georgia" }] }), fauxAssistantMessage("Written with hooks off")]);
		await runtime.session.prompt("Write the disposable library page with hooks still at their default.");
		expect(feedback()).toEqual([]);
		// Enable via the registered real Pi management tool; no direct config enablement.
		runtime.faux.setResponses([call("impeccable_run", { argv: ["hooks", "on"] }), fauxAssistantMessage("Project opted in")]);
		await runtime.session.prompt("Enable Impeccable automatic checks for this disposable project.");
		expect((await hookStatus(root)).enabled).toBe(true);
		const local = JSON.parse(await fs.readFile(path.join(root, ".impeccable/config.local.json"), "utf8"));
		expect(local.hook.consent).toBe("accepted");
		// A second changed write retains the same font finding, exercising native dedup.
		let sawAtBoundary = false;
		runtime.faux.setResponses([
			call("edit", { path: "page.html", edits: [{ oldText: "Georgia", newText: "Inter" }] }),
			call("write", { path: "page.html", content: bad.replace("Find books", "Browse books") }),
			fauxAssistantMessage("Review terminal findings"),
			(context) => {
				sawAtBoundary = JSON.stringify(context.messages).includes("overused-font");
				return call("edit", { path: "page.html", edits: [{ oldText: "Inter", newText: "Georgia" }] });
			},
			fauxAssistantMessage("One corrective continuation completed"),
		]);
		await runtime.session.prompt("Introduce Inter, review genuine automatic findings, and correct once if the completion boundary requests it.");
		const findings = feedback().filter((row) => row.status === "findings");
		f.receipt.detectorObserved = { feedback: feedback(), sawAtBoundary, callCount: runtime.faux.state.callCount, pendingResponses: runtime.faux.getPendingResponseCount() }; await f.save();
		expect(sawAtBoundary).toBe(true);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings.some((row) => row.text.includes("overused-font") && Number(row.audit?.freshFindings) > 0)).toBe(true);
		expect(feedback().filter((row) => ["error", "unavailable", "timeout", "truncated"].includes(row.status))).toEqual([]);
		expect(findings.filter((row) => row.phase === "completion")).toHaveLength(1);
		expect(findings.filter((row) => row.phase === "immediate")).toHaveLength(0);
		expect(runtime.faux.getPendingResponseCount()).toBe(0);
		expect(await fs.readFile(path.join(root, "page.html"), "utf8")).toContain("Georgia");
		// Exact scripted call consumption proves there was one corrective continuation.
		expect(runtime.faux.state.callCount).toBe(10);
		runtime.faux.setResponses([call("impeccable_run", { argv: ["hooks", "off"] }), fauxAssistantMessage("Checks disabled after evidence")]);
		await runtime.session.prompt("Disable automatic checks after the detector evidence.");
		expect((await hookStatus(root)).enabled).toBe(false);
		const tools = runtime.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(tools.every((row) => !row.isError)).toBe(true); expect(runtime.errors).toEqual([]);
		const audits = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const immediate = audits.filter((row) => row.event === "PostToolUse");
		expect(immediate).toHaveLength(3);
		expect(immediate[0]).toMatchObject({ findings: 1, freshFindings: 0, deferred: 1 });
		expect(immediate[1]).toMatchObject({ findings: 1, emitted: false, freshFindings: 0, deferred: 1 });
		expect(audits.filter((row) => row.event === "Stop" && row.freshFindings > 0)).toHaveLength(1);
		const hookDirectories = (await fs.readdir(f.temp)).filter((name) => name.startsWith("pi-impeccable-hook-"));
		expect(hookDirectories.length).toBeGreaterThan(0);
		const status = (await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, env: f.env })).stdout;
		expect(status).not.toContain("config.local.json");
		expect(status).not.toMatch(/audit|claims|sessions|hook-cache/);
		f.receipt.detector = { defaultOff: true, optedInViaPi: true, consent: local.hook.consent, feedback: feedback(), completionFindingBatches: 1, changedWriteFindingDeduplicated: true, audits, auditSha256: sha256(await fs.readFile(auditPath)), correctiveContinuations: 1, tools: tools.map((row) => row.toolName), sourceSha256: sha256(await fs.readFile(path.join(root, "page.html"))), privateHookDirectories: hookDirectories, localConfigExcluded: true };
		await f.save();
	} finally { await runtime.cleanup(); vi.stubEnv("IMPECCABLE_HOOK_LOG", undefined); expect(runtime.session.isStreaming).toBe(false); }
	expect((await fs.readdir(f.temp)).filter((name) => name.startsWith("pi-impeccable-hook-"))).toEqual([]);
	for (const file of ["auth.json", "models.json", "settings.json"]) await expect(fs.stat(path.join(f.env.PI_CODING_AGENT_DIR!, file))).rejects.toMatchObject({ code: "ENOENT" });
	f.receipt.detectorSessionClosed = true; f.receipt.detectorPrivateHookDirectoriesRemoved = true; await f.save();
}
