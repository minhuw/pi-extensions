import { act, render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { onDemand } from "../src/lib/onDemand";
import type { NodeFiles } from "../src/nodes/files";
import {
	AddCheckoutDialog,
	CheckoutSettingsDialog,
	ConfirmDialog,
	KeysHelp,
	NewWorktreeDialog,
	preloadOverlays,
	QuickOpen,
	RemoveWorktreeDialog,
	UndoToast,
} from "../src/nodes/deck/OnDemand";
import { gitCheckout } from "./support/checkouts";

const ATLAS = gitCheckout("a", "/home/me/code/atlas");
const noop = () => {};
// Quick open lists the folder as it opens; this node never answers, which is enough to show the dialog.
const files = { request: () => new Promise(() => {}) } as unknown as NodeFiles;

/** Every overlay Deck loads on demand, and what shows when it opens. */
const OVERLAYS: [string, () => ReactElement, () => HTMLElement | Promise<HTMLElement>][] = [
	[
		"confirmation",
		() => (
			<ConfirmDialog title="Kill this terminal?" confirmLabel="Kill" onCancel={noop} onConfirm={noop}>
				Sends SIGTERM to pi.
			</ConfirmDialog>
		),
		() => screen.findByRole("alertdialog", { name: "Kill this terminal?" }),
	],
	[
		"Add a repository",
		() => <AddCheckoutDialog nodeName="mac" home="/home/me" listFolders={async () => []} onAdd={async () => {}} onCancel={noop} />,
		() => screen.findByRole("dialog", { name: "Add a repository on mac" }),
	],
	[
		"New worktree",
		() => <NewWorktreeDialog projectName="atlas" checkout={ATLAS} home="/home/me" onCreate={async () => {}} onCancel={noop} />,
		() => screen.findByRole("dialog", { name: "New worktree of atlas" }),
	],
	[
		"Remove worktree",
		() => <RemoveWorktreeDialog nodeName="mac" path="/home/me/code/atlas-fix" home="/home/me" branch="fix" prunable={false} liveTerminals={0} onRemove={async () => {}} onCancel={noop} />,
		() => screen.findByRole("alertdialog", { name: "Remove the worktree fix?" }),
	],
	[
		"worktree settings",
		() => <CheckoutSettingsDialog checkoutName="atlas" checkout={ATLAS} home="/home/me" onSave={async () => {}} onCancel={noop} />,
		() => screen.findByRole("dialog", { name: "Worktree settings of atlas" }),
	],
	["shortcuts help", () => <KeysHelp onClose={noop} />, () => screen.findByRole("dialog", { name: "Keyboard shortcuts" })],
	["quick open", () => <QuickOpen files={files} home="/home/me" onPick={noop} onClose={noop} />, () => screen.findByRole("dialog", { name: "Open a file" })],
	[
		"undo notice",
		() => <UndoToast notice={{ id: 1, message: "Removed repo from Deck", undo: noop }} onDone={noop} />,
		() => screen.findByText("Removed repo from Deck"),
	],
];

describe("Deck's overlays, loaded on demand", () => {
	// Runs first in this file, so nothing has loaded the overlays' chunk yet.
	it.each(OVERLAYS)("open the %s before their chunk has loaded", async (_name, element, shown) => {
		const { unmount } = render(element());
		// Each component loads its part of the chunk on its first render: nothing shows until it has.
		expect(document.body.textContent).toBe("");
		expect(await shown()).toBeTruthy();
		unmount();
	});

	it("open at once, without suspending, once preloaded", async () => {
		await preloadOverlays();
		for (const [, element] of OVERLAYS.slice(0, 6)) {
			const { unmount } = render(element());
			expect(document.querySelector("[role=dialog], [role=alertdialog]")).not.toBeNull();
			unmount();
		}
	});
});

describe("onDemand", () => {
	it("draws the fallback while loading, then mounts the component once and keeps its state", async () => {
		let resolve!: (component: (props: { label: string }) => ReactElement) => void;
		const Counter = ({ label }: { label: string }) => {
			const [count, setCount] = useState(0);
			useEffect(() => setCount((current) => current + 1), []);
			return (
				<span data-loaded="">
					{label} {count}
				</span>
			);
		};
		const Late = onDemand(() => new Promise<(props: { label: string }) => ReactElement>((done) => (resolve = done)), <span data-fallback="" />);
		const { rerender } = render(<Late label="a" />);
		expect(document.querySelector("[data-fallback]")).not.toBeNull();
		await act(async () => resolve(Counter));
		expect(document.querySelector("[data-loaded]")!.textContent).toBe("a 1");
		// A render after the load keeps the instance mounted before it: its effect ran once, its state is kept.
		rerender(<Late label="b" />);
		expect(document.querySelector("[data-loaded]")!.textContent).toBe("b 1");
		expect(document.querySelector("[data-fallback]")).toBeNull();
	});

	it("loads again after a failed load", async () => {
		let calls = 0;
		const Flaky = onDemand(async () => {
			calls += 1;
			if (calls === 1) throw new Error("chunk gone");
			return () => <span />;
		});
		await expect(Flaky.preload()).rejects.toThrow("chunk gone");
		await Flaky.preload();
		expect(calls).toBe(2);
		render(<Flaky />);
		expect(calls).toBe(2);
	});
});
