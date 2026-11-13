import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import INDEX_HTML from "../index.html?raw";
import SOURCE from "../../resource/pika-icon.svg?raw";
import BOOT_JS from "../public/boot.js?raw";
import { PikaLogo } from "../src/components/icons";
import { PAGE_COLUMN } from "../src/components/ui";
import type { RunDetail } from "../src/lib/types";
import { TRANSCRIPT_COLUMN, TRAJECTORY_COLUMN } from "../src/pages/SessionView";
import { onlineSession, summary } from "./support/fixtures";
import { firstRender, mockLayout, renderApp } from "./support/render";
import { installMatchMedia } from "./support/media";
import { createFakeServer } from "./support/server";

/** The logo's shapes as the source of truth draws them: each fill with its path data or circle. */
function logoShapes(svg: string): string[] {
	return [...svg.matchAll(/<(path|circle)\b[^>]*>/g)].map((match) => {
		const attr = (name: string) => new RegExp(`\\b${name}=["']([^"']*)["']`).exec(match[0])?.[1] ?? "";
		return match[1] === "path" ? `${attr("fill")} ${attr("d")}` : `${attr("fill")} circle ${attr("cx")} ${attr("cy")} ${attr("r")}`;
	});
}

function run(): RunDetail {
	const at = "2026-10-20T09:00:00.000Z";
	return {
		run: { runId: "r-1", device: "mini", repo: "pi-extensions", title: "Add pika search", status: "running", startedAt: at, lastAt: at, stepCount: 0 },
		events: [],
		steps: [],
	};
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("logo", () => {
	it("draws the same four shapes as resource/pika-icon.svg", () => {
		const { container } = render(<PikaLogo size={22} />);
		const svg = container.querySelector("svg")!;
		expect(svg.getAttribute("viewBox")).toBe("0 0 1254 1254");
		expect(svg.getAttribute("width")).toBe("22");
		expect(svg.getAttribute("aria-hidden")).toBe("true");
		expect(logoShapes(svg.outerHTML)).toEqual(logoShapes(SOURCE));
		expect(logoShapes(SOURCE)).toHaveLength(4);
	});

	it("leads the sign band's home link, which is still named pika", async () => {
		renderApp("/", createFakeServer({}).fetch);
		const band = await screen.findByRole("banner");
		expect(band.hasAttribute("data-sign-band")).toBe(true);
		const home = within(band).getByRole("link", { name: "pika" });
		expect(home.getAttribute("href")).toBe("/");
		expect(home.querySelector("svg[data-pika-logo]")?.getAttribute("width")).toBe("22");
		// The home link comes first, ahead of the band's navigation.
		const nav = within(band).getByRole("navigation", { name: "Main" });
		expect(home.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("keeps a section's tab current on the pages inside it, and its own page the only current page", async () => {
		const server = createFakeServer({ sessions: [{ detail: summary("s1", { title: "Fix the parser" }), turns: [], entries: [] }], runs: [run()] });
		const current = (name: string) => within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name }).getAttribute("aria-current");
		const { unmount } = renderApp("/", server.fetch);
		await screen.findByRole("navigation", { name: "Main" });
		expect(current("Sessions")).toBe("page");
		unmount();

		renderApp("/s/s1", server.fetch);
		await screen.findByRole("heading", { name: "Fix the parser", level: 1 }, firstRender);
		expect(current("Sessions")).toBe("true");
		expect(current("Herder runs")).toBeNull();
	});

	it("is the favicon, inline so any base path works", () => {
		const href = /<link rel="icon"[^>]*href="([^"]*)"/.exec(INDEX_HTML)?.[1] ?? "";
		const prefix = "data:image/svg+xml,";
		expect(href.startsWith(prefix)).toBe(true);
		// URL-encoded, so the attribute holds no raw markup.
		expect(href).not.toMatch(/[<>#\s"]/);
		const svg = decodeURIComponent(href.slice(prefix.length));
		expect(svg).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 1254 1254'>/);
		expect(svg).not.toMatch(/<title|<desc/);
		expect(logoShapes(svg)).toEqual(logoShapes(SOURCE));
	});
});

describe("the page shell under the nodes Content-Security-Policy", () => {
	it("has no inline script and no <base>: only same-origin script files run", () => {
		const scripts = [...INDEX_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
		expect(scripts.length).toBeGreaterThan(0);
		for (const [, attributes, body] of scripts) {
			expect(attributes).toMatch(/\ssrc="\.\/[^"]+"/);
			expect(body.trim()).toBe("");
		}
		expect(INDEX_HTML).not.toMatch(/<base\b|createElement\(["']base/);
		// `vite-ignore` keeps it a file of its own: the build copies it from public/ and strips the attribute.
		expect(INDEX_HTML).toContain('<script vite-ignore src="./boot.js"></script>');
	});

	it.each([
		["dark", false, "dark"],
		["light", true, "light"],
		[null, true, "dark"],
		[null, false, "light"],
		["bogus", true, "dark"],
	] as const)("boot.js sets the theme from storage %s (system dark: %s) to %s", (stored, systemDark, theme) => {
		if (stored) localStorage.setItem("pika-theme", stored);
		installMatchMedia(systemDark);
		new Function(BOOT_JS)();
		expect(document.documentElement.dataset.theme).toBe(theme);
	});
});

describe("page width", () => {
	const routes: [string, string][] = [
		["/", "Sessions"],
		["/runs", "Herder runs"],
		["/runs/r-1", "Add pika search"],
		["/search", "Search"],
		["/devices", "Devices"],
		["/active", "Active sessions"],
		["/nowhere", "This page doesn’t exist"],
	];

	it.each(routes)("puts %s in the shared page column", async (path, title) => {
		const server = createFakeServer({ sessions: [{ detail: summary("s1", { title: "Fix the parser" }), turns: [], entries: [] }], runs: [run()] });
		renderApp(path, server.fetch);
		const heading = await screen.findByRole("heading", { name: title, level: 1 });
		const page = document.querySelector<HTMLElement>("[data-scroll-root] > div")!;
		expect(page.contains(heading)).toBe(true);
		for (const name of PAGE_COLUMN.split(" ")) expect(page.classList).toContain(name);
		// No width of its own besides the shared column's.
		const column = /max-w-\[[^\]]+\]/.exec(PAGE_COLUMN)![0];
		expect(page.className.match(/max-w-\[[^\]]+\]/g)).toEqual([column]);
	});

	it("gives the session header the full width, and the transcript body a reading column", async () => {
		const server = createFakeServer({ sessions: [{ detail: summary("s1", { title: "Fix the parser" }), turns: [], entries: [] }] });
		const first = renderApp("/s/s1", server.fetch);
		const heading = await screen.findByRole("heading", { name: "Fix the parser", level: 1 }, firstRender);
		const header = heading.closest<HTMLElement>("[data-session-header]")!;
		for (const name of TRAJECTORY_COLUMN.split(" ")) expect(header.classList).toContain(name);
		expect(header.className).not.toMatch(/max-w-/);
		expect(header.querySelector("[data-kpi-strip]")?.parentElement).toBe(header);
		first.unmount();

		renderApp("/s/s1?view=transcript", server.fetch);
		const again = await screen.findByRole("heading", { name: "Fix the parser", level: 1 }, firstRender);
		const sessionHeader = again.closest<HTMLElement>("[data-session-header]")!;
		for (const name of TRAJECTORY_COLUMN.split(" ")) expect(sessionHeader.classList).toContain(name);
		expect(sessionHeader.className).not.toMatch(/max-w-/);
		expect(sessionHeader.querySelector("[data-kpi-strip]")?.parentElement).toBe(sessionHeader);
		const body = document.querySelector("[data-transcript-body]")!;
		expect(body.contains(again)).toBe(false);
		for (const name of TRANSCRIPT_COLUMN.split(" ")) expect(body.classList).toContain(name);
		expect(TRANSCRIPT_COLUMN).toContain("max-w-[1100px]");
	});
});

describe("title badges", () => {
	it("follow the session title, which is clamped to two lines", async () => {
		const lastAt = new Date(Date.now() - 10_000).toISOString();
		const server = createFakeServer({
			sessions: [{ detail: summary("s1", { title: "Refactor the parser", lastAt }), turns: [], entries: [] }],
			online: [onlineSession("s1")],
		});
		renderApp("/s/s1", server.fetch);
		const heading = await screen.findByRole("heading", { name: "Refactor the parser", level: 1 }, firstRender);
		await waitFor(() => expect(document.querySelector("[data-online]")).not.toBeNull());
		// Long titles clamp to two lines and keep the full text in the tooltip.
		expect(heading.classList).toContain("line-clamp-2");
		expect(heading.getAttribute("title")).toBe("Refactor the parser");
		const badges = heading.nextElementSibling as HTMLElement;
		expect(badges.hasAttribute("data-title-badges")).toBe(true);
		expect(badges.classList).toContain("shrink-0");
		expect(badges.querySelector("[data-live]")?.textContent).toBe("live");
		expect(badges.querySelector("[data-online]")?.textContent).toBe("Online");
	});

	it("leave a title without badges a plain heading", async () => {
		const server = createFakeServer({ sessions: [{ detail: summary("s1", { title: "Old session" }), turns: [], entries: [] }] });
		renderApp("/s/s1", server.fetch);
		const heading = await screen.findByRole("heading", { name: "Old session", level: 1 }, firstRender);
		expect(heading.classList).not.toContain("inline");
		expect(document.querySelector("[data-title-badges]")).toBeNull();
	});
});

describe("empty states", () => {
	it("shows the logo when there are no Herder runs yet", async () => {
		renderApp("/runs", createFakeServer({}).fetch);
		const empty = (await screen.findByText("No Herder runs")).closest<HTMLElement>("[data-state=empty]")!;
		expect(empty.textContent).toContain("Runs appear here once a device uploads a Herder journal.");
		expect(empty.querySelector("svg[data-pika-logo]")?.getAttribute("width")).toBe("40");
	});

	it("keeps an empty search plain", async () => {
		renderApp("/search?q=nothing", createFakeServer({}).fetch);
		const empty = (await screen.findByText("No results")).closest<HTMLElement>("[data-state=empty]")!;
		expect(empty.querySelector("svg")).toBeNull();
	});
});
