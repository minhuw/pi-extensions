import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { liveSession } from "../support/live-session.ts";
import { runEngine, sha256 } from "../../src/engine.ts";
import { alive } from "./foundations.ts";
import { product, type Foundation } from "./detector-phase.ts";

export async function directionPhase(f: Foundation, root: string) {
	const requests: { method: string | undefined; url: string; headers: unknown }[] = [];
	const catalog = { poolRevision: "0123456789ab", handId: "00112233445566778899aabbccddeeff", approvedCount: 2, catalogCount: 3, challengers: [
		{ id: "teletext-service", form: "Teletext", spark: "A numbered broadcast index", system: ["Use a strict numbered grid"], webLeverage: "Searchable page rows" },
		{ id: "microfiche-reader", form: "Microfiche", spark: "Backlit library index", system: ["Keep a film-strip index"], webLeverage: "Scrollable shelves" },
	] };
	const server = createServer((req, res) => {
		requests.push({ method: req.method, url: req.url!, headers: req.headers });
		res.setHeader("Content-Type", "application/json");
		if (req.method === "POST" && req.url === "/api/chosen") { res.end('{"ok":true}'); return; }
		if (req.method !== "GET" || !req.url?.startsWith("/api/roll?")) { res.writeHead(404).end(); return; }
		res.end(JSON.stringify(catalog));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	const beforeProduct = await fs.readFile(path.join(root, "PRODUCT.md"));
	const originalEnv = { ...f.env };
	// Native opt-out deliberately omits API fields/rounds from the ledger. Enable
	// that protocol only in these native children, with every API call on loopback.
	Object.assign(f.env, { IMPECCABLE_API_URL: api, IMPECCABLE_API_TIMEOUT: "3000", IMPECCABLE_CATALOG_DIR: path.join(f.temp, "missing-catalog"), IMPECCABLE_NO_TELEMETRY: undefined });
	let daemonPid: number | undefined;
	let page: Awaited<ReturnType<typeof f.browser.newPage>> | undefined;
	let runtime: Awaited<ReturnType<typeof liveSession>> | undefined;
	const key = "visual-foundations";
	try {
		const seed = await f.native(root, ["concept-seed", "--scope", "direction", "--mode", "persuade", "--from", "k1"]);
		await fs.writeFile(path.join(f.artifacts, "concept-seed.txt"), seed);
		f.receipt.directionObserved = { seedSummary: seed.split("\n")[0], seedSha256: sha256(Buffer.from(seed)), requests }; await f.save();
		expect(seed).toMatch(/source: api/); expect(seed).toContain("0123456789ab");
		expect(requests).toHaveLength(1);
		const request = requests[0]; const url = new URL(request.url, api);
		expect(request.method).toBe("GET");
		expect(request.headers).not.toHaveProperty("authorization");
		expect(url.pathname).toBe("/api/roll");
		expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "direction", key: "k1", reroll: "0", mode: "persuade" });
		expect((request.headers as Record<string, string>)["x-impeccable-client"]).toBe("impeccable/4.8.0");
		const roll = JSON.parse(await fs.readFile(path.join(root, ".impeccable/questions/roll.json"), "utf8"));
		expect(roll).toMatchObject({ source: "api", poolRevision: "0123456789ab", mode: "persuade" });
		// Snapshot real native ledger files before --start consumes the pending roll.
		const ledger: Record<string, string> = {};
		async function collect(directory: string) {
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const file = path.join(directory, entry.name);
				if (entry.isDirectory()) await collect(file);
				else if (/\.(json|jsonl)$/.test(entry.name)) ledger[path.relative(root, file)] = await fs.readFile(file, "utf8");
			}
		}
		await collect(path.join(root, ".impeccable"));
		const dealtLedger = Object.entries(ledger).filter(([file]) => !file.endsWith("roll.json") && /seed|ledger/.test(file));
		expect(dealtLedger.length, "Native seed ledger must exist").toBeGreaterThan(0);
		for (const id of ["teletext-service", "microfiche-reader"]) expect(dealtLedger.some(([, text]) => text.includes(id))).toBe(true);
		const anatomy = { thesis: "A library index with an explicit reading order.", palette: ["#102030", "#f5e8ce", "#a43b21"], materials: ["printed paper", "ruled index"], viewport: "Opening hours above a numbered book index.", risk: "Dense rows need generous line spacing." };
		const payload = { title: "Choose the library visual world", question: "SIMULATED catalog; select a code-led direction for the disposable library.", buildPath: { value: "code", toggle: false }, options: [
			{ ...anatomy, id: "assigned", kind: "assigned", label: "Printed library", kicker: "THE ROLL" },
			{ ...anatomy, id: "model-pick", kind: "pick", label: "Quiet reading room", kicker: "IMPECCABLE’S PICK" },
			...catalog.challengers.map((card) => ({ ...anatomy, id: `challenger-${card.id}`, kind: "challenger", catalogId: card.id, label: card.form, lineage: card.spark, verdict: "competitive", case: card.webLeverage })),
		] };
		const payloadFile = path.join(root, "direction.json");
		// Real native validation must reject a card whose catalogId was never dealt.
		await fs.writeFile(payloadFile, JSON.stringify({ ...payload, options: payload.options.map((card) => card.kind === "challenger" ? { ...card, catalogId: "not-dealt" } : card) }));
		const rejected = await runEngine({ binary: "", cacheRoot: f.env.IMPECCABLE_HOME, env: f.env, cwd: root, argv: ["serve-question", "--start", "--no-open", "--key", key, "--payload", payloadFile] });
		expect(rejected).toMatchObject({ ok: false, status: "error", stdoutTruncated: false, stderrTruncated: false }); expect(rejected.stderr).toMatch(/catalogId|dealt/);
		await expect(fs.stat(path.join(root, `.impeccable/questions/${key}.state.json`))).rejects.toMatchObject({ code: "ENOENT" });
		await fs.writeFile(payloadFile, JSON.stringify(payload));
		const start = await f.native(root, ["serve-question", "--start", "--no-open", "--key", key, "--payload", payloadFile, "--timeout", "120"]);
		const boardUrl = start.match(/QUESTION URL: (\S+)/)?.[1]; expect(boardUrl).toBeTruthy();
		expect(["127.0.0.1", "localhost"]).toContain(new URL(boardUrl!).hostname);
		expect(new URL(boardUrl!).protocol).toBe("http:");
		const state = JSON.parse(await fs.readFile(path.join(root, `.impeccable/questions/${key}.state.json`), "utf8"));
		daemonPid = state.pid; expect(daemonPid).toBeTypeOf("number"); expect(alive(daemonPid!)).toBe(true);
		page = await f.browser.newPage();
		const outbound: string[] = [];
		await page.route("**/*", (route) => {
			const target = new URL(route.request().url());
			if (["127.0.0.1", "localhost"].includes(target.hostname)) return route.continue();
			outbound.push(target.origin); return route.abort();
		});
		await page.goto(boardUrl!, { waitUntil: "networkidle", timeout: 20_000 });
		await expect.poll(() => page!.locator("button.choose").count()).toBe(payload.options.length);
		for (const card of payload.options) {
			const rendered = page.locator("article.card").filter({ has: page.locator(`button.choose[data-id="${card.id}"]`) });
			expect(await rendered.count()).toBe(1);
			const text = await rendered.innerText();
			for (const fact of [card.label, card.thesis, card.viewport, card.risk, ...card.materials]) expect(text.toLowerCase()).toContain(fact.toLowerCase());
			expect(await rendered.locator(".swatches i").evaluateAll((chips) => chips.map((chip) => chip.getAttribute("title")))).toEqual(card.palette);
		}
		expect(await page.locator("#build-path").count()).toBe(0);
		const pageHash = sha256(Buffer.from(await page.content()));
		await page.screenshot({ path: path.join(f.artifacts, "direction-board.png"), fullPage: true });
		const chosen = "challenger-teletext-service";
		await page.locator(`button.choose[data-id="${chosen}"]`).click();
		const answerText = await f.native(root, ["serve-question", "--wait", "--key", key, "--poll", "10"]);
		expect(answerText).toMatch(/ANSWER:/);
		const answerLine = answerText.split("\n").find((line) => line.startsWith("ANSWER:"))!;
		const answer = JSON.parse(answerLine.slice("ANSWER:".length).trim());
		expect(answer.optionId).toBe(chosen); expect(answer.buildPath).toBe("code");
		await page.screenshot({ path: path.join(f.artifacts, "direction-answer.png"), fullPage: true });
		// Decision authority and brief are recorded through actual native Pi tools.
		const selectedCard = payload.options.find((card) => card.id === answer.optionId)!;
		const authority = `# Visual authority\n\nChosen direction: ${answer.optionId} — ${selectedCard.label}\n\nThesis: ${selectedCard.thesis}\nPalette: ${selectedCard.palette.join(", ")}\nMaterials: ${selectedCard.materials.join(", ")}\nFirst viewport: ${selectedCard.viewport}\nRisk: ${selectedCard.risk}\nNative answer: ${JSON.stringify(answer)}\nCatalog: SIMULATED local /api/roll. Build path: code.\n`;
		runtime = await liveSession(root, undefined, undefined, true, f.env.PI_CODING_AGENT_DIR!);
		runtime.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "DESIGN.md", content: authority })]),
			fauxAssistantMessage([fauxToolCall("edit", { path: "surface-brief.md", edits: [{ oldText: "Await a direction decision.", newText: `FORM: ${selectedCard.label}; ${roll.seed}. Chosen direction: ${answer.optionId}. Visual authority: DESIGN.md. Surface: library index; opening hours above numbered rows. Product truth remains PRODUCT.md.` }] })]),
			fauxAssistantMessage("Recorded the actual browser choice"),
		]);
		await runtime.session.prompt(`Record the native browser answer ${JSON.stringify(answer)} in visual authority and surface brief; preserve PRODUCT.md bytes.`);
		for (const file of ["DESIGN.md", "surface-brief.md"]) expect(await fs.readFile(path.join(root, file), "utf8")).toContain(chosen);
		expect(await fs.readFile(path.join(root, "PRODUCT.md"))).toEqual(beforeProduct); expect(beforeProduct.toString()).toBe(product);
		const tools = runtime.session.sessionManager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		expect(tools.map((row) => row.toolName)).toEqual(["write", "edit"]); expect(tools.every((row) => !row.isError)).toBe(true); expect(runtime.errors).toEqual([]);
		expect(await fs.readFile(path.join(root, "surface-brief.md"), "utf8")).toContain(roll.seed);
		expect(requests).toHaveLength(1);
		expect(outbound).toEqual([]);
		for (const secret of [root, f.env.HOME!, product, "font-family"]) expect(JSON.stringify(requests)).not.toContain(secret);
		f.receipt.direction = { daemonPid, catalog: "SIMULATED", requests, seedSummary: seed.split("\n")[0], seedSha256: sha256(Buffer.from(seed)), roll, ledger: Object.fromEntries(dealtLedger.map(([file, text]) => [file, JSON.parse(text)])), ledgerHashes: Object.fromEntries(dealtLedger.map(([file, text]) => [file, sha256(Buffer.from(text))])), invalidCatalogIdRejected: rejected.stderr, pageUrl: boardUrl, pageSha256: pageHash, payloadSha256: sha256(Buffer.from(JSON.stringify(payload))), answer, selectedCard, answerText, nativeTools: tools.map((row) => row.toolName), productSha256: sha256(beforeProduct), designSha256: sha256(await fs.readFile(path.join(root, "DESIGN.md"))), briefSha256: sha256(await fs.readFile(path.join(root, "surface-brief.md"))), externalBrowserRequests: outbound };
		await f.save();
	} finally {
		const cleaned = await Promise.allSettled([
			runtime?.cleanup(), page?.close(),
			(async () => {
				await f.native(root, ["serve-question", "--stop", "--key", key]);
				if (daemonPid !== undefined) await expect.poll(() => alive(daemonPid!), { timeout: 10_000 }).toBe(false);
			})(),
			new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
		]);
		expect(server.listening).toBe(false);
		for (const key of Object.keys(f.env)) delete f.env[key]; Object.assign(f.env, originalEnv);
		f.receipt.directionCleanup = { daemonStopped: daemonPid === undefined || !alive(daemonPid), fixtureServerClosed: true, pageClosed: page?.isClosed() ?? true, piSessionClosed: runtime ? !runtime.session.isStreaming : true }; await f.save();
		const failures = cleaned.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (failures.length) throw new AggregateError(failures, "Direction phase resource cleanup failed");
	}
}
