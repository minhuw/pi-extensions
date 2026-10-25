import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY } from "../src/lib/theme";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";
import { installMatchMedia } from "./support/media";

describe("theme", () => {
	it("defaults to the light theme when the system is light", () => {
		renderApp("/", createFakeServer({}).fetch);
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
	});

	it("follows a dark system setting until toggled", () => {
		installMatchMedia(true);
		renderApp("/", createFakeServer({}).fetch);
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
	});

	it("toggles and persists the choice across reloads", () => {
		const first = renderApp("/", createFakeServer({}).fetch);
		fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
		first.unmount();

		delete document.documentElement.dataset.theme;
		renderApp("/", createFakeServer({}).fetch);
		expect(document.documentElement.dataset.theme).toBe("dark");
		fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
	});
});
