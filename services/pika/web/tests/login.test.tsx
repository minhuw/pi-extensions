import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeNext } from "../src/pages/Login";
import { assistantMessage, entry, header, summary, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

function session(): FakeSession {
	return {
		detail: summary("s1", { title: "Protected session" }),
		entries: [entry(0, header("s1")), entry(1, userMessage("hello")), entry(2, assistantMessage([{ type: "text", text: "hi" }]))],
		turns: [turn(0, 1, 2, { userText: "hello" })],
	};
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("login", () => {
	it("sends the user to the login page and back after signing in", async () => {
		const server = createFakeServer({ sessions: [session()], password: "hunter2" });
		renderApp("/s/s1", server.fetch);
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
		expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();

		const input = screen.getByLabelText("Password");
		fireEvent.change(input, { target: { value: "wrong" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByText("Wrong password")).toBeTruthy();
		expect(server.state.authenticated).toBe(false);

		fireEvent.change(input, { target: { value: "hunter2" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("heading", { name: "Protected session" })).toBeTruthy();
		expect(server.state.authenticated).toBe(true);
		expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
	});

	it("sends any 401 to the login page", async () => {
		// A server that reports no password from `me` but rejects the read API, e.g. after a restart with one.
		const base = createFakeServer({ sessions: [session()], password: "hunter2" });
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/api/v1/me")) return new Response(JSON.stringify({ authenticated: true, passwordRequired: false }));
			return base.fetch(input, init);
		}) as typeof fetch;
		renderApp("/s/s1", fetchImpl);
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
	});

	it("stays open when no password is configured", async () => {
		renderApp("/s/s1", createFakeServer({ sessions: [session()] }).fetch);
		expect(await screen.findByRole("heading", { name: "Protected session" })).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull());
	});

	it("only follows same-app paths after login", () => {
		expect(safeNext("/s/abc?seq=3")).toBe("/s/abc?seq=3");
		expect(safeNext("//evil.example")).toBe("/");
		expect(safeNext("https://evil.example")).toBe("/");
		expect(safeNext("/login?next=/x")).toBe("/");
		expect(safeNext(null)).toBe("/");
	});
});
