import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPage } from "../src/components/AuthGate";
import { ApiError } from "../src/lib/api";
import { formatWait } from "../src/lib/format";
import { loginErrorMessage, safeNext } from "../src/pages/Login";
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

	it("queries nothing but `me` before a signed-out browser reaches the login page", async () => {
		const server = createFakeServer({ sessions: [session()], password: "hunter2" });
		renderApp("/", server.fetch);
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
		expect(server.calls).toEqual(["/api/v1/me"]);
	});

	it("sends any 401 to the login page in password mode", async () => {
		// `me` still reads as signed in, but the session has ended on the server.
		const base = createFakeServer({ sessions: [session()], password: "hunter2" });
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/api/v1/me")) {
				return new Response(JSON.stringify({ authenticated: true, passwordRequired: true, authMode: "password" }));
			}
			return base.fetch(input, init);
		}) as typeof fetch;
		renderApp("/s/s1", fetchImpl);
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
	});

	it.each(["proxy", "none"] as const)("reloads instead of showing the password form on a 401 in %s mode", async (authMode) => {
		sessionStorage.clear();
		const reload = vi.spyOn(browserPage, "reload").mockImplementation(() => {});
		// The proxy's own session ended: it answers 401 before pika sees the request.
		const base = createFakeServer({ sessions: [session()], authMode });
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("/api/v1/sessions")) return new Response("", { status: 401 });
			return base.fetch(input, init);
		}) as typeof fetch;
		let sawPassword = false;
		const observer = new MutationObserver(() => {
			sawPassword ||= document.querySelector("input[type=password]") !== null;
		});
		observer.observe(document.body, { childList: true, subtree: true });
		try {
			renderApp("/s/s1", fetchImpl);
			await waitFor(() => expect(reload).toHaveBeenCalled());
			// Several failing queries reload once, and a later 401 does not reload again right away.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(reload).toHaveBeenCalledTimes(1);
			expect(sawPassword).toBe(false);
			expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
		} finally {
			observer.disconnect();
			reload.mockRestore();
		}
	});

	it("stays open when no password is configured", async () => {
		renderApp("/s/s1", createFakeServer({ sessions: [session()] }).fetch);
		expect(await screen.findByRole("heading", { name: "Protected session" })).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull());
	});

	it("shows the wait after too many failed attempts", async () => {
		const server = createFakeServer({ sessions: [session()], password: "hunter2", loginRetryAfter: 840 });
		renderApp("/", server.fetch);
		const input = await screen.findByLabelText("Password");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			fireEvent.change(input, { target: { value: `wrong-${attempt}` } });
			fireEvent.click(screen.getByRole("button", { name: "Continue" }));
			expect(await screen.findByText("Wrong password")).toBeTruthy();
		}
		fireEvent.change(input, { target: { value: "hunter2" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByText("Too many attempts. Try again in 14 minutes.")).toBeTruthy();
		expect(server.state.authenticated).toBe(false);
	});

	it("words the rate-limit wait in minutes or seconds", () => {
		const limited = (retryAfter?: number) => new ApiError(429, "too_many_attempts", { error: "too_many_attempts", retryAfter }, retryAfter);
		expect(loginErrorMessage(limited(45))).toBe("Too many attempts. Try again in 45 seconds.");
		expect(loginErrorMessage(limited(61))).toBe("Too many attempts. Try again in 2 minutes.");
		expect(loginErrorMessage(limited(undefined))).toBe("Too many attempts. Try again later.");
		expect(loginErrorMessage(new ApiError(401, "invalid_password"))).toBe("Wrong password");
		expect(formatWait(1)).toBe("1 second");
		expect(formatWait(60)).toBe("1 minute");
		expect(formatWait(900)).toBe("15 minutes");
	});

	it.each(["proxy", "none"] as const)("never shows the login page in %s mode", async (authMode) => {
		const server = createFakeServer({ sessions: [session()], authMode });
		renderApp("/login?next=%2Fs%2Fs1", server.fetch);
		expect(await screen.findByRole("heading", { name: "Protected session" })).toBeTruthy();
		expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});

	it("only follows same-app paths after login", () => {
		expect(safeNext("/s/abc?seq=3")).toBe("/s/abc?seq=3");
		expect(safeNext("//evil.example")).toBe("/");
		expect(safeNext("https://evil.example")).toBe("/");
		expect(safeNext("/login?next=/x")).toBe("/");
		expect(safeNext(null)).toBe("/");
	});
});
