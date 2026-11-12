import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { menuBelow, useMenu } from "../src/nodes/deck/Menu";
import { DeckTooltips, tip } from "../src/nodes/deck/Tooltips";
import { DECK_ROOT } from "../src/nodes/deck/tokens";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Deck's frame", () => {
	it("fills the window with its own bar instead of the band, and reaches pika's sections from the app menu", async () => {
		const server = createFakeServer({ features: [] });
		renderApp("/deck", server.fetch);
		await screen.findByText("Nodes are off on this server");
		expect(document.querySelector("[data-deck] [data-deck-bar]")).not.toBeNull();
		expect(document.querySelector("[data-sign-band]")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Deck/ }));
		const menu = screen.getByRole("menu", { name: "pika" });
		const labels = [...menu.querySelectorAll("[role='menuitem']")].map((item) => item.textContent);
		// Relay is off: its sections are not offered.
		expect(labels).toEqual(expect.arrayContaining(["Sessions", "Statistics", "Devices", "Settings", "Documentation"]));
		expect(labels).not.toContain("Chatrooms");
		fireEvent.click(screen.getByRole("menuitem", { name: "Statistics" }));
		await waitFor(() => expect(document.querySelector("[data-sign-band]")).not.toBeNull());
		expect(document.querySelector("[data-deck-bar]")).toBeNull();
	});

	it("is the band's Deck tab while nodes are on", async () => {
		const server = createFakeServer({ features: ["nodes"] });
		renderApp("/devices", server.fetch);
		const tab = await screen.findByRole("link", { name: "Deck" });
		expect(tab.getAttribute("href")).toBe("/deck");
	});
});

function MenuHost() {
	const { menu, open, close, openFor } = useMenu();
	const [ran, setRan] = useState<string[]>([]);
	return (
		<div {...DECK_ROOT}>
			<button
				type="button"
				onClick={(event) =>
					openFor
						? close()
						: open({
								...menuBelow(event.currentTarget),
								label: "Things",
								items: [
									{ id: "a", label: "Alpha", run: () => setRan((list) => [...list, "a"]) },
									{ id: "b", label: "Bravo", disabled: true, run: () => setRan((list) => [...list, "b"]) },
									"separator",
									{ id: "c", label: "Charlie", shortcut: "⌘C", danger: true, run: () => setRan((list) => [...list, "c"]) },
								],
							})
				}
			>
				Open
			</button>
			<output data-ran={ran.join(",")} />
			{menu}
		</div>
	);
}

describe("Deck's menu", () => {
	it("starts on the first item, skips disabled ones, jumps by letter, and gives focus back on Escape", async () => {
		render(<MenuHost />);
		const button = screen.getByRole("button", { name: "Open" });
		button.focus();
		fireEvent.click(button);
		const menu = screen.getByRole("menu", { name: "Things" });
		await waitFor(() => expect(document.activeElement?.textContent).toBe("Alpha"));
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		expect(document.activeElement?.textContent).toContain("Charlie");
		expect(document.activeElement?.querySelector("kbd")?.textContent).toBe("⌘C");
		fireEvent.keyDown(menu, { key: "a" });
		expect(document.activeElement?.textContent).toBe("Alpha");
		fireEvent.keyDown(menu, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("runs an item and closes; its button toggles it; a press outside closes it", async () => {
		render(<MenuHost />);
		const button = screen.getByRole("button", { name: "Open" });
		fireEvent.click(button);
		fireEvent.click(screen.getByRole("menuitem", { name: /Charlie/ }));
		expect(screen.queryByRole("menu")).toBeNull();
		expect(document.querySelector("[data-ran]")?.getAttribute("data-ran")).toBe("c");

		fireEvent.click(button);
		expect(screen.getByRole("menu")).toBeTruthy();
		// The button's own press does not count as outside, so its click closes rather than reopens.
		fireEvent.pointerDown(button);
		fireEvent.click(button);
		expect(screen.queryByRole("menu")).toBeNull();

		fireEvent.click(button);
		fireEvent.pointerDown(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
	});
});

describe("Deck's tooltips", () => {
	it("show a control's name and shortcut after a pause, and hide on a press", () => {
		vi.useFakeTimers();
		function Host() {
			const [root, setRoot] = useState<HTMLDivElement | null>(null);
			return (
				<div ref={setRoot} {...DECK_ROOT}>
					<button type="button" aria-label="Keyboard shortcuts" {...tip("Keyboard shortcuts", "help")}>
						?
					</button>
					<DeckTooltips root={root} />
				</div>
			);
		}
		render(<Host />);
		const button = screen.getByRole("button", { name: "Keyboard shortcuts" });
		fireEvent.pointerOver(button, { pointerType: "mouse" });
		act(() => vi.advanceTimersByTime(300));
		expect(document.querySelector("[data-tooltip]")).toBeNull();
		act(() => vi.advanceTimersByTime(400));
		const bubble = document.querySelector("[data-tooltip]");
		expect(bubble?.textContent?.startsWith("Keyboard shortcuts")).toBe(true);
		expect(bubble?.querySelector("kbd")?.textContent).toBeTruthy();
		expect(bubble?.getAttribute("aria-hidden")).toBe("true");
		fireEvent.pointerDown(button);
		expect(document.querySelector("[data-tooltip]")).toBeNull();
	});

	it("never show for touch", () => {
		vi.useFakeTimers();
		function Host() {
			const [root, setRoot] = useState<HTMLDivElement | null>(null);
			return (
				<div ref={setRoot}>
					<button type="button" {...tip("Kill")}>
						x
					</button>
					<DeckTooltips root={root} />
				</div>
			);
		}
		render(<Host />);
		fireEvent.pointerOver(screen.getByRole("button"), { pointerType: "touch" });
		act(() => vi.advanceTimersByTime(1000));
		expect(document.querySelector("[data-tooltip]")).toBeNull();
	});
});
