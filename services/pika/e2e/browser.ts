import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { LARGE_ENTRIES, LARGE_TURNS } from "./large.ts";
import { check, checkEqual, log, sleep, waitFor } from "./util.ts";

/** Entry rows rendered in the DOM must stay below this for a 5,000-entry session. */
const MAX_ENTRY_NODES = 300;

export interface BrowserTargets {
	url: string;
	password: string;
	chrome: string;
	artifacts: string;
	profile: string;
	mainId: string;
	childId: string;
	stepId: string;
	runId: string;
	largeId: string;
	searchWord: string;
	/** Prompt texts of the main session, in order. */
	prompts: string[];
	/** The `/herder <goal>` command among them, whose card shows the prompt Herder sent. */
	herderPrompt: string;
}

/** Drives the embedded UI in the locally installed Chrome and fails on any console error, page error, or failed request. */
export async function runBrowser(targets: BrowserTargets): Promise<void> {
	mkdirSync(targets.artifacts, { recursive: true });
	const browser = await puppeteer.launch({
		executablePath: targets.chrome,
		headless: true,
		userDataDir: targets.profile,
		// Chrome's sandbox refuses to run as root, as in some CI containers.
		args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync"],
	});
	try {
		await flow(browser, targets);
	} finally {
		await browser.close();
	}
}

async function flow(browser: Browser, t: BrowserTargets): Promise<void> {
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 960 });
	const problems: string[] = [];
	page.on("console", (message) => { if (message.type() === "error") problems.push(`console error: ${message.text()} (${message.location().url ?? ""})`); });
	page.on("pageerror", (error) => problems.push(`page error: ${error instanceof Error ? error.message : String(error)}`));
	page.on("requestfailed", (request) => problems.push(`request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
	page.on("response", (response) => { if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.request().method()} ${response.url()}`); });
	const noProblems = (where: string) => check(problems.length === 0, `browser problems ${where}:\n  ${problems.join("\n  ")}`);

	const shots: string[] = [];
	let theme = "light";
	const shot = async (name: string) => {
		await sleep(250);
		const path = join(t.artifacts, `${name}-${theme}.png`);
		await page.screenshot({ path, fullPage: false });
		shots.push(path);
	};
	const go = async (path: string) => {
		await page.goto(`${t.url}${path}`, { waitUntil: "networkidle0" });
	};
	const count = (selector: string) => page.$$eval(selector, (nodes) => nodes.length);
	const textOf = (selector: string) => page.$eval(selector, (node) => (node as HTMLElement).innerText);
	const visible = (selector: string, timeout = 15_000) => page.waitForSelector(selector, { visible: true, timeout });
	// Virtualized lists render rows a frame after they scroll into view.
	const click = async (selector: string) => {
		await visible(selector);
		await page.click(selector);
	};

	// 1. Login: the UI sends a signed-out browser to the login page.
	await go("/");
	await page.waitForSelector("#pika-password", { timeout: 15_000 });
	check(page.url().includes("/login"), `the signed-out UI stays at ${page.url()} instead of the login page`);
	await shot("01-login");
	await page.type("#pika-password", t.password);
	await click("button[type=submit]");
	await visible(`[data-session-row="${t.mainId}"]`);
	log("browser: signed in");

	// 2. The session list shows the root sessions; the device filter narrows it to the desktop's large session.
	const listed = async () => page.$$eval("[data-session-row]", (nodes) => nodes.map((node) => node.getAttribute("data-session-row")));
	await visible(`[data-session-row="${t.largeId}"]`);
	const roots = await listed();
	check(roots.includes(t.mainId) && roots.includes(t.largeId), `the session list shows ${JSON.stringify(roots)}`);
	check(!roots.includes(t.childId) && !roots.includes(t.stepId), "the session list shows child sessions without the subagent filter");
	await shot("02-sessions");
	await click("[aria-label=Filters] button[aria-haspopup]::-p-text(Device)");
	await click("[role=menu] [role=menuitemradio]::-p-text(desktop)");
	await waitFor(async () => {
		const rows = await listed();
		return rows.length === 1 && rows[0] === t.largeId;
	}, 10_000, "the device filter to list only the desktop session");
	check(page.url().includes("device=desktop"), `the device filter is not in the URL ${page.url()}`);
	await shot("03-sessions-filtered");
	log("browser: session list and device filter");

	// 3. Session view: prompt cards, and the bash, read, and edit renderers once the first turn expands.
	await go(`/s/${encodeURIComponent(t.mainId)}`);
	await visible("[data-turn='0']");
	check((await textOf("[data-turn='0']")).includes(t.prompts[0]!.slice(0, 30)), "the first prompt card does not show the first prompt");
	await shot("04-session");
	// The list is virtualized: later prompt cards render once they scroll into view.
	const scrollUntil = async (selector: string, label: string) => waitFor(async () => {
		if ((await count(selector)) > 0) return true;
		await page.$eval("[data-scroll-root]", (root) => { root.scrollTop += root.clientHeight / 2; });
		return false;
	}, 20_000, label, 50);
	const herderTurn = `[data-turn='${t.prompts.indexOf(t.herderPrompt)}']`;
	await scrollUntil(herderTurn, "the prompt card of /herder");
	check((await textOf(herderTurn)).includes("/herder: run"), "the /herder prompt card does not show Herder's prompt");
	const lastTurn = `[data-turn='${t.prompts.length - 1}']`;
	await scrollUntil(lastTurn, "the last prompt card");
	check((await textOf(lastTurn)).includes(t.prompts[t.prompts.length - 1]!), "the last prompt card does not show the last prompt");
	await page.$eval("[data-scroll-root]", (root) => { root.scrollTop = 0; });
	await click("[data-work-strip='0']");
	for (const tool of ["bash", "read", "edit"]) await visible(`[data-tool="${tool}"]`);
	check((await textOf("[data-tool='bash']")).includes(t.searchWord), "the bash renderer does not show the command's output");
	await visible("[data-tool='edit'] [data-diff]");
	await shot("05-session-tools");
	log("browser: prompt cards and tool renderers");

	// 4. What the model saw: the system prompt and the messages of the first model call.
	await click("[data-turn-list] [data-context-button]");
	await visible("[data-context-drawer]");
	await visible("[data-context-drawer] [data-system-sections]");
	await visible("[data-context-drawer] [data-context-message]");
	const drawer = await textOf("[data-context-drawer]");
	check(drawer.includes("System prompt") && drawer.includes("Messages"), "the context drawer has no system prompt or messages section");
	check(drawer.includes(t.prompts[0]!.slice(0, 30)), "the context drawer does not show the user's message");
	await shot("06-context");
	await page.keyboard.press("Escape");
	await page.waitForSelector("[data-context-drawer]", { hidden: true });
	log("browser: context drawer");

	// 5. The subagent nests inline under its Agent call.
	await click("[data-work-strip='0']");
	await click("[data-work-strip='1']");
	await visible("[data-agent-card]");
	await click(`[data-inline-toggle="${t.childId}"] button`);
	await visible(`[data-inline-session="${t.childId}"] [data-turn='0']`);
	check((await textOf(`[data-inline-session="${t.childId}"]`)).includes("Read README.md"), "the inline subagent does not show its prompt");
	await click(`[data-inline-session="${t.childId}"] [data-work-strip='0']`);
	await visible(`[data-inline-session="${t.childId}"] [data-tool='read']`);
	await shot("07-subagent");
	log("browser: inline subagent");

	// 6. The Herder run lists its step, which links to the step's session.
	await go("/runs");
	await visible(`[data-run-row="${t.runId}"]`);
	await shot("08-runs");
	await click(`[data-run-row="${t.runId}"]`);
	await visible("[data-step]");
	await visible(`[data-step] a[href$="/s/${t.stepId}"]`);
	await shot("09-run");
	await click(`[data-step] a[href$="/s/${t.stepId}"]`);
	await waitFor(() => page.url().endsWith(`/s/${t.stepId}`), 10_000, "the step session page");
	await visible("[data-turn='0']");
	await shot("10-step-session");
	log("browser: Herder run and step session");

	// 7. Search finds a word only a tool result contains and deep-links to it.
	await go("/search");
	await page.type("input[type=search]", t.searchWord);
	const hit = `[data-result-group="${t.mainId}"] [data-hit][data-kind="tool-result"]`;
	await visible(hit);
	check((await textOf(hit)).includes(t.searchWord), "the search hit does not show the word");
	await shot("11-search");
	const seq = await page.$eval(hit, (node) => node.getAttribute("data-hit"));
	await click(hit);
	await waitFor(() => page.url().includes(`/s/${t.mainId}`), 10_000, "the search hit's session");
	const target = await visible("[data-entry-seq][data-highlighted]");
	check((await target!.evaluate((node) => (node as HTMLElement).innerText)).includes(t.searchWord), `the deep link to seq ${seq} highlights an entry without the word`);
	await shot("12-search-target");
	log("browser: search and deep link");

	// 8. The 5,000-entry session keeps few entry rows in the DOM with every turn expanded.
	await go(`/s/${encodeURIComponent(t.largeId)}`);
	await visible(`[data-turn='${LARGE_TURNS - 1}']`);
	// From the last turn up, so the turns above stay in place.
	for (let turn = LARGE_TURNS - 1; turn >= 0; turn--) {
		await click(`[data-work-strip='${turn}']`);
		await page.waitForSelector(`[data-work-strip='${turn}'][aria-expanded=true]`);
	}
	await visible("[data-entry-seq]");
	const entryNodes = () => count("[data-entry-seq]");
	const scrollTo = (fraction: number) => page.$eval("[data-scroll-root]", (root, f) => { root.scrollTop = (root.scrollHeight - root.clientHeight) * f; }, fraction);
	const top = await entryNodes();
	check(top > 0 && top < MAX_ENTRY_NODES, `${top} entry rows in the DOM at the top of the large session`);
	await shot("13-large-top");
	await scrollTo(0.5);
	await sleep(600);
	const middle = await entryNodes();
	check(middle > 0 && middle < MAX_ENTRY_NODES, `${middle} entry rows in the DOM in the middle of the large session`);
	await shot("14-large-middle");
	let most = Math.max(top, middle);
	await waitFor(async () => {
		await scrollTo(1);
		await sleep(250);
		most = Math.max(most, await entryNodes());
		check(most < MAX_ENTRY_NODES, `${most} entry rows in the DOM while scrolling the large session`);
		return (await count(`[data-entry-seq="${LARGE_ENTRIES}"]`)) > 0;
	}, 90_000, "the last entry of the large session", 50);
	const bottom = await entryNodes();
	check(bottom > 0 && bottom < MAX_ENTRY_NODES, `${bottom} entry rows in the DOM at the bottom of the large session`);
	await shot("15-large-bottom");
	log(`browser: large session keeps ${top}/${middle}/${bottom} entry rows (top/middle/bottom), at most ${most}`);
	noProblems("in the light theme");

	// 9. The dark theme, and every page again in it.
	await go("/");
	await click("[data-theme-toggle]");
	await waitFor(() => page.evaluate(() => document.documentElement.dataset.theme === "dark"), 5_000, "the dark theme");
	const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	checkEqual(background !== "rgb(255, 255, 255)", true, `the dark theme keeps a white background (${background})`);
	theme = "dark";
	await visible(`[data-session-row="${t.mainId}"]`);
	await shot("02-sessions");
	await go(`/s/${encodeURIComponent(t.mainId)}`);
	await visible("[data-work-strip='0']");
	check(await page.evaluate(() => document.documentElement.dataset.theme === "dark"), "the dark theme does not persist across pages");
	await click("[data-work-strip='0']");
	await visible("[data-tool='edit'] [data-diff]");
	await shot("05-session-tools");
	await click("[data-turn-list] [data-context-button]");
	await visible("[data-context-drawer] [data-context-message]");
	await shot("06-context");
	await page.keyboard.press("Escape");
	await page.waitForSelector("[data-context-drawer]", { hidden: true });
	await click("[data-work-strip='0']");
	await click("[data-work-strip='1']");
	await click(`[data-inline-toggle="${t.childId}"] button`);
	await visible(`[data-inline-session="${t.childId}"] [data-turn='0']`);
	await shot("07-subagent");
	await go("/runs");
	await visible(`[data-run-row="${t.runId}"]`);
	await shot("08-runs");
	await go(`/runs/${encodeURIComponent(t.runId)}`);
	await visible("[data-step]");
	await shot("09-run");
	await go(`/search?q=${encodeURIComponent(t.searchWord)}`);
	await visible(hit);
	await shot("11-search");
	await go(`/s/${encodeURIComponent(t.largeId)}`);
	await visible("[data-turn='0']");
	await shot("13-large-top");
	await go("/login");
	await visible("#pika-password");
	await shot("01-login");
	noProblems("in the dark theme");
	log(`browser: ${shots.length} screenshots`);
}
