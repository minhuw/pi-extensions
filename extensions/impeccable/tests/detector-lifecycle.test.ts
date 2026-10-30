import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { DetectorFeedback } from "../src/detector.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

isolateEngineEnvironment();

it.each([
	{ enabled: false, edit: false, continuation: false },
	{ enabled: false, edit: true, continuation: false },
	{ enabled: false, edit: false, continuation: true },
	{ enabled: true, edit: true, continuation: false },
	{ enabled: true, edit: true, continuation: true },
])("composes earlier boundary entries and continuation with enabled=$enabled/edit=$edit/continuation=$continuation", async ({ enabled, edit, continuation }) => {
	let requested = false;
	const proposals: string[] = [];
	const h = await detectorFixture(undefined, [], { before(pi) {
		pi.on("turn_end", (event) => {
			const content = `Required earlier extension context for turn ${event.turnIndex}`;
			proposals.push(content);
			const terminal = event.message.role === "assistant" && !event.message.content.some((item) => item.type === "toolCall");
			const shouldContinue = continuation && terminal && !requested;
			if (shouldContinue) requested = true;
			return { entries: [...event.entries,
				{ type: "custom", customType: "earlier-state", data: content },
				{ type: "custom_message", customType: "earlier-context", content, display: false },
			], ...(shouldContinue ? { continue: true } : {}) };
		});
	} });
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		if (enabled) await h.config({ hook: { enabled: true } });
		const requests: string[] = [];
		const answer = (context: unknown) => { requests.push(JSON.stringify(context)); return fauxAssistantMessage("Assessed the proposed context"); };
		h.faux.setResponses([
			...(edit ? [fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "composed edit" })])] : []),
			answer,
			...(continuation ? [answer] : []),
			...(enabled && edit ? [answer] : []),
		]);
		await h.session.prompt("Preserve the earlier extension's boundary context");
		const entries = h.session.sessionManager.getEntries();
		expect(entries.flatMap((entry) => entry.type === "custom" && entry.customType === "earlier-state" ? [entry.data] : [])).toEqual(proposals);
		expect(entries.flatMap((entry) => entry.type === "custom_message" && entry.customType === "earlier-context" ? [entry.content] : [])).toEqual(proposals);
		if (continuation) {
			expect(requested).toBe(true);
			expect(requests[1]).toContain(proposals[edit ? 1 : 0]);
		}
		if (enabled && edit) {
			expect(h.feedback()).toHaveLength(2);
			expect((await h.calls()).map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop"]);
		} else expect(await h.calls()).toEqual([]);
		expect(h.faux.getPendingResponseCount()).toBe(0);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it.each(["error", "malformed", "truncated", "unavailable"])("reports %s without corrupting successful native tool output or continuing", async (outcome) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = outcome === "unavailable" ? path.join(h.directory, "missing engine") : h.binary;
		await h.config({ hook: { enabled: true }, fixtureResult: outcome });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "successful edit" })]), fauxAssistantMessage("Reported detector limitation")]);
		await h.session.prompt("Edit and report the detector outcome accurately");
		expect(await readFile(path.join(h.directory, "page.html"), "utf8")).toBe("successful edit");
		expect(h.faux.state.callCount).toBe(2);
		const feedback = JSON.stringify(h.feedback());
		expect(feedback).toContain(`"status":"${outcome === "malformed" ? "error" : outcome}"`);
		if (outcome === "error") expect(feedback).toContain("fixture detector failure");
		expect(h.errors).toEqual([]);
		const writes = h.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "write" ? [entry.message] : []);
		expect(writes[0]?.isError).toBe(false);
	} finally { await h.close(); }
});

it.each([
	{ section: "detector", config: "config.json", extension: ".twig" },
	{ section: "detector", config: "config.json", extension: " TWIG " },
	{ section: "detector", config: "config.local.json", extension: { ext: " .Twig ", engine: "text" } },
	{ section: "hook", config: "config.json", extension: " twig " },
	{ section: "hook", config: "config.local.json", extension: { ext: "Twig" } },
])("scans configured template extensions through native writes: $section/$config/$extension", async ({ section, config, extension }) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true } });
		await writeFile(path.join(h.directory, ".impeccable", config), JSON.stringify(section === "hook" ? { hook: { enabled: true, extensions: [extension] } } : { hook: { enabled: true }, detector: { extensions: [extension] } }));
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.twig", content: "<main>Template edit</main>" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed findings")]);
		await h.session.prompt("Edit the configured template");
		const calls = await h.calls();
		expect(calls.map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop"]);
		expect(calls[0].event.tool_input.file_path).toBe(path.join(h.directory, "page.twig"));
		expect(calls[0].event.tool_response).toMatchObject({ originalFile: null, content: "<main>Template edit</main>", userModified: false });
		expect(JSON.stringify(h.feedback())).toContain("Fixture immediate finding");
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it.each(["audit-error", "audit-error-stop"])("reports upstream exit-zero detector-threw audits with silent stdout without continuing: %s", async (outcome) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, fixtureClean: true, fixtureResult: outcome });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "<main>Successful edit</main>" })]), fauxAssistantMessage("Reported missing detector coverage"), fauxAssistantMessage("Forbidden correction")]);
		await h.session.prompt("Edit and report detector failures");
		expect(await readFile(path.join(h.directory, "page.html"), "utf8")).toBe("<main>Successful edit</main>");
		expect((await h.calls()).map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop"]);
		const feedback = h.feedback().flatMap((entry) => entry.type === "custom_message" ? (entry.details as { feedback: DetectorFeedback[] }).feedback : []);
		const errors = feedback.filter((entry) => entry.status === "error");
		// Repeated identical audit errors are deduplicated across both passes.
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ phase: outcome === "audit-error" ? "immediate" : "completion", status: "error", text: expect.stringContaining("detector-threw; detector coverage is unavailable"), audit: { emitted: false, error: "detector-threw" } });
		expect(h.faux.state.callCount).toBe(2);
		expect(h.faux.getPendingResponseCount()).toBe(1);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("cancels stale delayed feedback when real Pi steering input is queued", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, delay: 5000 });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "first user edit" })]), fauxAssistantMessage("Responded to the newer user input")]);
		const run = h.session.prompt("Start a delayed scan");
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 3000;
			const check = async () => { if ((await h.calls()).length) { resolve(); return; } if (Date.now() > deadline) { reject(new Error("Hook did not start")); return; } setTimeout(() => { void check(); }, 10); }; void check();
		});
		await h.session.prompt("Stop the detector correction; answer this newer request.", { streamingBehavior: "steer" });
		await run;
		expect(h.feedback()).toHaveLength(0);
		expect(await h.calls()).toHaveLength(1);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it.each(["abort", "shutdown", "steer"])("cancels the real Pi completion Stop subprocess on %s without late feedback or correction", async (action) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, delayStop: 5000 });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "delayed deep pass" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Forbidden late correction")]);
		const run = h.session.prompt("Edit then finish with a deep pass");
		const call = await new Promise<{ pid: number }>((resolve, reject) => {
			const deadline = Date.now() + 3000;
			const check = async () => {
				const stop = (await h.calls()).find((call) => call.event.hook_event_name === "Stop");
				if (stop) { resolve(stop); return; }
				if (Date.now() > deadline) { reject(new Error("Stop hook did not start")); return; }
				setTimeout(() => { void check(); }, 10);
			}; void check();
		});
		const before = Date.now();
		if (action === "abort") await h.session.abort();
		else if (action === "shutdown") await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		else await h.session.prompt("Answer the newer request", { streamingBehavior: "steer" });
		await run;
		expect(Date.now() - before).toBeLessThan(2000);
		expect(() => process.kill(call.pid, 0)).toThrow();
		expect(await h.calls()).toHaveLength(2);
		expect(JSON.stringify(h.feedback())).not.toContain('"phase":"completion"');
		expect(h.faux.state.callCount).toBe(action === "steer" ? 3 : 2);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it.each(["@", "~", "@~"])("captures preimages and scans the actual native write/edit path with %s syntax", async (syntax) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true } });
		const file = path.join(h.directory, "page.html");
		const supplied = syntax === "@" ? "@page.html" : `${syntax}/${path.relative(os.homedir(), file).split(path.sep).join("/")}`;
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: supplied, content: "native write" })]),
			fauxAssistantMessage([fauxToolCall("edit", { path: supplied, edits: [{ oldText: "write", newText: "edit" }] })]),
			fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed"),
		]);
		await h.session.prompt("Edit through native path syntax");
		const calls = await h.calls();
		expect(calls.map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "PostToolUse", "Stop"]);
		expect(calls[0].event.tool_input.file_path).toBe(file);
		expect(calls[0].event.tool_response).toMatchObject({ originalFile: "<main>before</main>", content: "native write", userModified: false });
		expect(calls[1].event.tool_response).toMatchObject({ originalFile: "native write", content: "native edit", userModified: false });
		expect(await readFile(file, "utf8")).toBe("native edit");
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("reports identical findings again after a clean edit within the same invocation", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, fixtureCleanContent: "fixed" });
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "finding" })]),
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "fixed" })]),
			fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "finding" })]),
			fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed"),
		]);
		await h.session.prompt("Introduce, resolve and reintroduce a finding");
		const feedback = h.feedback().flatMap((entry) => entry.type === "custom_message" ? (entry.details as { feedback: DetectorFeedback[] }).feedback : []);
		expect(feedback.filter((entry) => entry.phase === "immediate" && entry.status === "findings")).toHaveLength(2);
		expect((await h.calls()).map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "PostToolUse", "PostToolUse", "Stop"]);
		expect(h.faux.state.callCount).toBe(5);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("permits fresh identical feedback and its bounded correction on a later user invocation", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true }, fixtureCleanContent: "fixed" });
		for (const content of ["finding", "fixed", "finding"]) {
			h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content })]), fauxAssistantMessage("Done"), ...(content === "fixed" ? [] : [fauxAssistantMessage("Assessed")])]);
			await h.session.prompt("Edit again");
			expect(h.faux.getPendingResponseCount()).toBe(0);
		}
		const feedback = h.feedback().flatMap((entry) => entry.type === "custom_message" ? (entry.details as { feedback: DetectorFeedback[] }).feedback : []);
		expect(feedback.filter((entry) => entry.phase === "immediate" && entry.status === "findings")).toHaveLength(2);
		const completion = feedback.filter((entry) => entry.phase === "completion" && entry.status === "findings");
		expect(completion).toHaveLength(2);
		expect(completion[0].text).toBe(completion[1].text);
		expect(h.faux.state.callCount).toBe(8);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("releases owned detector resources on a real Pi branch transition", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true } });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "first branch edit" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		await h.session.prompt("Edit first branch");
		const previous = (await h.calls())[0].event.session_id;
		const user = h.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!user) throw new Error("Missing user entry");
		await h.session.navigateTree(user.id);
		expect((await readdir(path.join(h.directory, ".impeccable"))).some((name) => name.startsWith("pi-hook-"))).toBe(false);
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "second branch edit" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		await h.session.prompt("Edit second branch");
		expect((await h.calls())[2].event.session_id).not.toBe(previous);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});
