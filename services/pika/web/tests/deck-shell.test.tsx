import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../src/components/ui-shadcn/dialog";
import { menuBelow, useMenu, type MenuEntry } from "../src/nodes/deck/Menu";
import { DeckTooltips, tip } from "../src/nodes/deck/Tooltips";
import { DECK_ROOT } from "../src/nodes/deck/tokens";
import { firstRender, renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("Deck's frame", () => {
	it("fills the window with its own bar instead of the band, and reaches pika's sections from the app menu", async () => {
		const server = createFakeServer({ features: [] });
		renderApp("/deck", server.fetch);
		await screen.findByText("Nodes are off on this server", {}, firstRender);
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

function MenuHost({ items }: { items?: (ran: (id: string) => void) => MenuEntry[] }) {
	const { menu, open, close, openFor } = useMenu();
	const [ran, setRan] = useState<string[]>([]);
	const record = (id: string) => setRan((list) => [...list, id]);
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
								items: items?.(record) ?? [
									{ id: "a", label: "Alpha", icon: "copy", run: () => record("a") },
									{ id: "b", label: "Bravo", disabled: true, reason: "Update pika-node on mac to use this", run: () => record("b") },
									"separator",
									{ id: "c", label: "Charlie", shortcut: "⌘C", danger: true, run: () => record("c") },
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

const ranList = () => document.querySelector("[data-ran]")?.getAttribute("data-ran");

/** Opens the host's menu as the keyboard does (Enter on the focused button) or as the pointer does. */
function openMenu(button: HTMLElement, by: "keyboard" | "pointer") {
	button.focus();
	if (by === "keyboard") fireEvent.keyDown(button, { key: "Enter" });
	else fireEvent.pointerDown(button);
	fireEvent.click(button);
	return screen.getByRole("menu", { name: "Things" });
}
const highlighted = () => document.querySelector("[data-highlighted]");

describe("Deck's menu", () => {
	it("starts on the first item from the keyboard, highlights a disabled one with its reason, jumps by letter, and gives focus back on Escape", async () => {
		render(<MenuHost />);
		const button = screen.getByRole("button", { name: "Open" });
		openMenu(button, "keyboard");
		await waitFor(() => expect(document.activeElement?.textContent).toBe("Alpha"));
		expect(highlighted()).toBe(document.activeElement);
		expect(document.activeElement?.querySelector("[data-slot='dropdown-menu-icon'] svg")).not.toBeNull();
		// A disabled item can be highlighted, says why beside the menu (and as its description), and does nothing when chosen.
		fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		const bravo = document.activeElement!;
		expect(bravo.textContent).toBe("Bravo");
		expect(bravo.getAttribute("aria-disabled")).toBe("true");
		expect(document.getElementById(bravo.getAttribute("aria-describedby")!)?.textContent).toBe("Update pika-node on mac to use this");
		await waitFor(() => expect(document.querySelector("[data-menu-reason]")?.textContent).toBe("Update pika-node on mac to use this"));
		fireEvent.click(bravo);
		expect(ranList()).toBe("");
		expect(screen.getByRole("menu")).toBeTruthy();
		fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		expect(document.activeElement?.textContent).toContain("Charlie");
		await waitFor(() => expect(document.querySelector("[data-menu-reason]")).toBeNull());
		expect(document.activeElement?.querySelector("kbd")?.textContent).toBe("⌘C");
		expect(document.activeElement?.getAttribute("data-variant")).toBe("destructive");
		fireEvent.keyDown(document.activeElement!, { key: "a" });
		await waitFor(() => expect(document.activeElement?.textContent).toBe("Alpha"));
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(document.activeElement).toBe(button);
	});

	it("opens from the pointer with nothing highlighted; runs an item and closes; its button toggles it; a press outside closes it", async () => {
		render(<MenuHost />);
		const button = screen.getByRole("button", { name: "Open" });
		const menu = openMenu(button, "pointer");
		await waitFor(() => expect(document.activeElement).toBe(menu));
		expect(highlighted()).toBeNull();
		fireEvent.keyDown(menu, { key: "ArrowDown" });
		await waitFor(() => expect(document.activeElement?.textContent).toBe("Alpha"));
		fireEvent.click(screen.getByRole("menuitem", { name: /Charlie/ }));
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(ranList()).toBe("c");
		expect(document.activeElement).toBe(button);

		openMenu(button, "pointer");
		// The button's own press does not count as outside, so its click closes rather than reopens.
		fireEvent.pointerDown(button);
		fireEvent.click(button);
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

		openMenu(button, "pointer");
		fireEvent.pointerDown(document.body);
		fireEvent.click(document.body);
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	});

	it("names groups by their headers and opens submenus from the keyboard and the pointer", async () => {
		render(
			<MenuHost
				items={(ran) => [
					{ kind: "header", label: "atlas · mac" },
					{ id: "t", label: "New Terminal", run: () => ran("t") },
					"separator",
					{ kind: "header", label: "Other nodes" },
					{
						id: "node01",
						label: "node01",
						icon: "node",
						submenu: [
							{ id: "t", label: "New Terminal", run: () => ran("node01:t") },
							{ id: "p", label: "Add Project…", run: () => ran("node01:p") },
						],
					},
				]}
			/>,
		);
		const button = screen.getByRole("button", { name: "Open" });
		openMenu(button, "keyboard");
		expect(within(screen.getByRole("group", { name: "atlas · mac" })).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["New Terminal"]);
		const parent = screen.getByRole("menuitem", { name: "node01" });
		expect(within(screen.getByRole("group", { name: "Other nodes" })).getByRole("menuitem")).toBe(parent);
		expect(parent.getAttribute("aria-haspopup")).toBe("menu");

		// Keyboard: Right opens it with focus inside, Left closes it and returns to its item.
		await waitFor(() => expect(document.activeElement?.textContent).toBe("New Terminal"));
		fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		expect(document.activeElement).toBe(parent);
		fireEvent.keyDown(parent, { key: "ArrowRight" });
		const sub = await screen.findByRole("menu", { name: "node01" });
		expect(parent.getAttribute("aria-expanded")).toBe("true");
		await waitFor(() => expect(sub.contains(document.activeElement)).toBe(true));
		fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
		await waitFor(() => expect(screen.queryByRole("menu", { name: "node01" })).toBeNull());
		expect(document.activeElement).toBe(parent);
		// Escape in a submenu closes only that one.
		fireEvent.keyDown(parent, { key: "ArrowRight" });
		const again = await screen.findByRole("menu", { name: "node01" });
		await waitFor(() => expect(again.contains(document.activeElement)).toBe(true));
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu", { name: "node01" })).toBeNull());
		expect(screen.getByRole("menu", { name: "Things" })).toBeTruthy();
		await waitFor(() => expect(document.activeElement).toBe(parent));

		// A click opens it too; choosing in it runs the item and closes the whole menu.
		fireEvent.click(parent);
		fireEvent.click(within(await screen.findByRole("menu", { name: "node01" })).getByRole("menuitem", { name: "Add Project…" }));
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(ranList()).toBe("node01:p");
		expect(document.activeElement).toBe(button);

		// A press inside a submenu is not outside the menu.
		openMenu(button, "pointer");
		fireEvent.click(screen.getByRole("menuitem", { name: "node01" }));
		fireEvent.pointerDown(await screen.findByRole("menu", { name: "node01" }));
		expect(screen.getByRole("menu", { name: "Things" })).toBeTruthy();
	});

	it("leaves focus in a dialog an item opens: the menu closing late does not pull it back", async () => {
		function Host() {
			const [asking, setAsking] = useState(false);
			return (
				<>
					<MenuHost items={() => [{ id: "add", label: "Add Project…", run: () => setAsking(true) }]} />
					{asking && (
						<Dialog open onOpenChange={(open) => !open && setAsking(false)}>
							<DialogContent>
								<DialogTitle>Add</DialogTitle>
								<input autoFocus aria-label="Folder" />
							</DialogContent>
						</Dialog>
					)}
				</>
			);
		}
		render(<Host />);
		const button = screen.getByRole("button", { name: "Open" });
		openMenu(button, "keyboard");
		await waitFor(() => expect(document.activeElement?.textContent).toBe("Add Project…"));
		fireEvent.keyDown(document.activeElement!, { key: "Enter" });
		fireEvent.click(document.activeElement!);
		const field = await screen.findByRole("textbox", { name: "Folder" });
		await waitFor(() => expect(document.activeElement).toBe(field));
		// Base UI reports the menu closed again after the dialog took focus; give it time to try.
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(document.activeElement).toBe(field);
		// Escape closes the dialog and gives focus back to the menu's button.
		fireEvent.keyDown(field, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(button));
	});

	it("takes focus with nothing to choose, so Escape still closes a menu that only explains", async () => {
		render(<MenuHost items={() => [{ kind: "note", text: "No node is connected" }]} />);
		const button = screen.getByRole("button", { name: "Open" });
		const menu = openMenu(button, "keyboard");
		await waitFor(() => expect(document.activeElement).toBe(menu));
		expect(menu.querySelector("[data-menu-note]")?.textContent).toBe("No node is connected");
		fireEvent.keyDown(menu, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(document.activeElement).toBe(button);
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
