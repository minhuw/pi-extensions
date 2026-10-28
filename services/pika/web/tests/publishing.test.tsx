import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PikaApi, type PublishingSettings } from "../src/lib/api";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer } from "./support/server";
import { row, session } from "./support/trajectory";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Only the public namespace is forwarded to this fixture's session data; private requests are recorded too. */
function publicServer() {
	const source = createFakeServer({ sessions: [session()] });
	const calls: string[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("/api/public/v1/")) return source.fetch(url.replace("/api/public/v1/", "/api/v1/"), init);
		if (url === "/api/health") return source.fetch(input, init);
		return json({ error: "unauthorized" }, 401);
	};
	return { fetch: fetchImpl, calls };
}

let restore: () => void;
beforeEach(() => { restore = mockLayout({ viewport: 20_000, rowHeight: 80 }); });
afterEach(() => restore());

describe("project publishing", () => {
	it("publishes and unpublishes a project from Settings and links to its public gallery", async () => {
		const source = createFakeServer({ password: "password", authenticated: true });
		let settings: PublishingSettings = { projects: [{ project: "pika", sessionCount: 2, published: false }] };
		const mutations: unknown[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			if (String(input) === "/api/v1/settings/publishing") {
				if (init?.method === "PATCH") {
					const body = JSON.parse(String(init.body));
					mutations.push(body);
					settings = { projects: [{ ...settings.projects[0]!, published: body.published }] };
				}
				return json(settings);
			}
			return source.fetch(input, init);
		};
		renderApp("/settings", fetchImpl);
		expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
		const toggle = await screen.findByRole("switch", { name: "Publish pika" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
		expect(screen.getByRole("link", { name: /View public project/ }).getAttribute("href")).toBe("/public?project=pika");
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
		expect(mutations).toEqual([{ project: "pika", published: true }, { project: "pika", published: false }]);
		expect(screen.getByText(/Matching names across machines/)).toBeTruthy();
	});

	it("shows a failed publication without marking the project public", async () => {
		const source = createFakeServer({});
		const fetchImpl: typeof fetch = async (input, init) => String(input) === "/api/v1/settings/publishing"
			? init?.method === "PATCH" ? json({ error: "failed_to_save" }, 500) : json({ projects: [{ project: "pika", sessionCount: 1, published: false }] })
			: source.fetch(input, init);
		renderApp("/settings", fetchImpl);
		fireEvent.click(await screen.findByRole("switch", { name: "Publish pika" }));
		expect(await screen.findByText("failed_to_save")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "Publish pika" }).getAttribute("aria-checked")).toBe("false");
	});

	it("browses and opens public trajectories without login or relay requests", async () => {
		const server = publicServer();
		renderApp("/public?project=pika", server.fetch);
		expect(await screen.findByRole("heading", { name: "Published trajectories" })).toBeTruthy();
		const link = await screen.findByRole("link", { name: /Fix the flaky test/ });
		expect(link.getAttribute("href")).toBe("/public/s/t1");
		fireEvent.click(link);
		expect(await screen.findByRole("heading", { name: "Fix the flaky test" })).toBeTruthy();
		await waitFor(() => expect(document.querySelector("[data-trajectory]")).toBeTruthy());
		expect(screen.getByRole("button", { name: "Replay the session" })).toBeTruthy();
		fireEvent.click(row("[data-kind='llm']"));
		await screen.findByRole("tab", { name: "Rendered" });
		expect(screen.queryByRole("tab", { name: "Context" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Export JSONL" })).toBeNull();
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
		expect(server.calls.some((call) => call.startsWith("/api/v1/"))).toBe(false);
		expect(server.calls).toContain("/api/public/v1/sessions/t1/trace");
	});

	it("serves the public transcript and keeps project navigation public", async () => {
		const server = publicServer();
		renderApp("/public/s/t1?view=transcript", server.fetch);
		await waitFor(() => expect(document.querySelector("[data-session-page='transcript']")).toBeTruthy());
		fireEvent.click(await screen.findByRole("button", { name: /4 model calls/ }));
		expect(await screen.findByText("Fixed the retry count.")).toBeTruthy();
		const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
		expect(within(breadcrumb).getByRole("link", { name: "pika" }).getAttribute("href")).toBe("/public/?project=pika");
		expect(server.calls.some((call) => call.startsWith("/api/v1/"))).toBe(false);
	});

	it("shows an unavailable session publicly without sending the visitor to login", async () => {
		const server = publicServer();
		renderApp("/public/s/private", server.fetch);
		expect(await screen.findByRole("heading", { name: "This session doesn’t exist" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Back to sessions" }).getAttribute("href")).toBe("/public/");
		expect(server.calls).not.toContain("/api/v1/me");
	});

	it("uses anonymous uncached requests under the configured base path", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const api = new PikaApi("/pika", async (input, init) => { calls.push({ url: String(input), init }); return json({ items: [], nextCursor: null }); }).forPublic();
		await act(async () => { await api.sessions({ project: "repo name" }); });
		expect(calls[0]?.url).toBe("/pika/api/public/v1/sessions?project=repo+name");
		expect(calls[0]?.init?.credentials).toBe("omit");
		expect(calls[0]?.init?.cache).toBe("no-store");
		expect(api.rawEntryUrl("a/b", 2)).toBe("/pika/api/public/v1/sessions/a%2Fb/entries/2/raw");
	});
});
