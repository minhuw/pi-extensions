import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PikaApi, type PublishingSettings } from "../src/lib/api";
import { inGuestView } from "../src/lib/guestView";
import { firstRender, mockLayout, renderApp } from "./support/render";
import { createFakeServer } from "./support/server";
import { row, session } from "./support/trajectory";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Only the public namespace is forwarded to this fixture's session data; private requests are recorded too. */
function publicServer(sessions = [session()]) {
	const source = createFakeServer({ sessions });
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

/** A password-protected server whose public API serves `published` sessions, as a signed-out visitor sees it. */
function guestServer(published = [session()], { signedIn = false } = {}) {
	const owner = createFakeServer({ sessions: [session()], password: "hunter2", authenticated: signedIn });
	const gallery = createFakeServer({ sessions: published });
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		return url.startsWith("/api/public/v1/") ? gallery.fetch(url.replace("/api/public/v1/", "/api/v1/"), init) : owner.fetch(input, init);
	};
	return { fetch: fetchImpl, owner, gallery };
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
		await waitFor(() => expect(document.querySelector("[data-session-page='transcript']")).toBeTruthy(), firstRender);
		fireEvent.click(await screen.findByRole("button", { name: /4 model calls/ }));
		expect(await screen.findByText("Fixed the retry count.")).toBeTruthy();
		const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
		expect(within(breadcrumb).getByRole("link", { name: "pika" }).getAttribute("href")).toBe("/public/?project=pika");
		expect(server.calls.some((call) => call.startsWith("/api/v1/"))).toBe(false);
	});

	it("links a published session to its repository", async () => {
		const published = session();
		published.detail = { ...published.detail, repository: "https://github.com/minhuw/pi-extensions" };
		renderApp("/public/s/t1", publicServer([published]).fetch);
		const link = await screen.findByRole("link", { name: "Open minhuw/pi-extensions on GitHub" }, firstRender);
		expect(link.getAttribute("href")).toBe("https://github.com/minhuw/pi-extensions");
	});

	it("shows an unavailable session publicly without sending the visitor to login", async () => {
		const server = publicServer();
		renderApp("/public/s/private", server.fetch);
		expect(await screen.findByRole("heading", { name: "This session doesn’t exist" }, firstRender)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Back to sessions" }).getAttribute("href")).toBe("/public/");
		expect(document.querySelector("[data-guest-note]")).toBeNull();
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

describe("signed-out visitors", () => {
	it("open the gallery at home when a project is published", async () => {
		renderApp("/?project=pika", guestServer().fetch);
		expect(await screen.findByRole("heading", { name: "Published trajectories" })).toBeTruthy();
		expect(await screen.findByRole("link", { name: /Fix the flaky test/ })).toBeTruthy();
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
		expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login?next=%2F%3Fproject%3Dpika");
	});

	it("open a published session's link publicly, and signing in returns to the owner's page", async () => {
		const server = guestServer();
		renderApp("/s/t1", server.fetch);
		expect(await screen.findByRole("heading", { name: "Fix the flaky test" }, firstRender)).toBeTruthy();
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
		const signIn = screen.getByRole("link", { name: "Sign in" });
		expect(signIn.getAttribute("href")).toBe("/login?next=%2Fs%2Ft1");
		fireEvent.click(signIn);
		fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "hunter2" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
		expect(await screen.findByRole("heading", { name: "Fix the flaky test" })).toBeTruthy();
		expect(server.owner.state.authenticated).toBe(true);
	});

	it("are asked for the password at a private session's link, with the gallery offered", async () => {
		renderApp("/s/private", guestServer().fetch);
		expect(await screen.findByRole("heading", { name: "Sign in to pika" }, firstRender)).toBeTruthy();
		expect((await screen.findByRole("link", { name: "Browse public trajectories" })).getAttribute("href")).toBe("/public");
	});

	it("are asked for the password at home when nothing is published", async () => {
		const server = guestServer([]);
		renderApp("/", server.fetch);
		expect(await screen.findByRole("heading", { name: "Sign in to pika" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Browse public trajectories" })).toBeNull();
	});

	it("go straight on from a sign-in link when the browser is already signed in", async () => {
		const server = createFakeServer({ sessions: [session()], password: "hunter2", authenticated: true });
		const first = renderApp("/login?next=%2Fs%2Ft1", server.fetch);
		expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
		expect(screen.queryByLabelText("Password")).toBeNull();
		first.unmount();

		// Without a destination, the login page stays.
		renderApp("/login", server.fetch);
		await waitFor(() => expect(server.calls).toContain("/api/v1/me"));
		expect(screen.getByRole("heading", { name: "Sign in to pika" })).toBeTruthy();
	});
});

describe("the owner's guest view", () => {
	it("opens a session as a guest sees it, without the owner's API, and returns to the owner's page", async () => {
		const server = guestServer([session()], { signedIn: true });
		renderApp("/s/t1?view=transcript", server.fetch);
		const viewAsGuest = await screen.findByRole("link", { name: "View as guest" }, firstRender);
		expect(viewAsGuest.getAttribute("href")).toBe("/public/s/t1?view=transcript");
		const before = server.owner.calls.length;
		fireEvent.click(viewAsGuest);
		await waitFor(() => expect(document.querySelector("[data-session-page='transcript']")).toBeTruthy());
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
		expect(server.owner.calls.slice(before).filter((call) => call.startsWith("/api/v1/"))).toEqual([]);
		expect(server.gallery.calls.some((call) => call.startsWith("/api/v1/sessions/t1"))).toBe(true);
		expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();

		const exit = screen.getByRole("link", { name: "Exit guest view" });
		expect(exit.getAttribute("href")).toBe("/login?next=%2Fs%2Ft1%3Fview%3Dtranscript");
		fireEvent.click(exit);
		expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
		expect(screen.queryByLabelText("Password")).toBeNull();
		expect(inGuestView()).toBe(false);
	});

	it("tells only the owner why a guest misses a private session", async () => {
		renderApp("/s/t1", guestServer([], { signedIn: true }).fetch);
		fireEvent.click(await screen.findByRole("link", { name: "View as guest" }, firstRender));
		expect(await screen.findByRole("heading", { name: "This session doesn’t exist" })).toBeTruthy();
		const note = document.querySelector("[data-guest-note]")!;
		expect(note.textContent).toContain("this session’s project isn’t published");
		expect(within(note as HTMLElement).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
	});

	it("opens the gallery from the session list with its filters, and from any other page", async () => {
		const server = guestServer([session()], { signedIn: true });
		const list = renderApp("/?project=pika", server.fetch);
		expect((await screen.findByRole("link", { name: "View as guest" })).getAttribute("href")).toBe("/public?project=pika");
		list.unmount();
		renderApp("/settings", server.fetch);
		expect((await screen.findByRole("link", { name: "View as guest" })).getAttribute("href")).toBe("/public");
	});
});
