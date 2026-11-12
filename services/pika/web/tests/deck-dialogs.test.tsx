import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { KeysHelp } from "../src/nodes/KeysHelp";
import { AddProjectDialog, ConfirmDialog, NewWorktreeDialog, UndoToast, type UndoNotice } from "../src/nodes/deck/RailDialogs";

describe("Deck's confirmations", () => {
	it("are alert dialogs named by their title, with Cancel focused first; Escape cancels and a press beside does not", async () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		render(
			<ConfirmDialog title="Kill this terminal?" confirmLabel="Kill" onCancel={onCancel} onConfirm={onConfirm} label="kill">
				Sends SIGTERM to pi.
			</ConfirmDialog>,
		);
		const dialog = screen.getByRole("alertdialog", { name: "Kill this terminal?" });
		expect(dialog.getAttribute("data-dialog")).toBe("kill");
		// Deck's shortcuts stand still while a modal is open (`useKeyDispatch` looks for aria-modal).
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Sends SIGTERM to pi.");
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
		fireEvent.pointerDown(document.querySelector("[data-slot='alert-dialog-overlay']")!);
		fireEvent.click(document.querySelector("[data-slot='alert-dialog-overlay']")!);
		expect(onCancel).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Kill" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("hold still while locked: no Escape, no Cancel, no confirmation", async () => {
		const onCancel = vi.fn();
		render(
			<ConfirmDialog title="Remove the worktree x?" confirmLabel="Remove Worktree" busy locked onCancel={onCancel} onConfirm={() => {}}>
				Deletes it.
			</ConfirmDialog>,
		);
		const dialog = screen.getByRole("alertdialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "Remove Worktree" }).hasAttribute("disabled")).toBe(true);
	});
});

describe("New Worktree", () => {
	it("asks for a branch, creates with Enter, can leave pi out, and shows git's refusal in place", async () => {
		const requests: unknown[] = [];
		const onCreate = vi.fn(async (request: unknown) => {
			requests.push(request);
			if (requests.length === 1) throw new Error("git: a branch named 'feature/a' already exists");
		});
		const onCancel = vi.fn();
		render(<NewWorktreeDialog projectName="atlas" onCreate={onCreate} onCancel={onCancel} />);
		expect(screen.getByRole("dialog", { name: "New worktree of atlas" }).getAttribute("aria-modal")).toBe("true");
		const branch = document.querySelector<HTMLInputElement>("[data-worktree-branch]")!;
		await waitFor(() => expect(document.activeElement).toBe(branch));
		fireEvent.keyDown(branch, { key: "Enter" });
		expect(document.querySelector("[data-dialog-error]")!.textContent).toBe("Name the new branch");
		expect(onCreate).not.toHaveBeenCalled();

		fireEvent.change(branch, { target: { value: "feature/a" } });
		const start = screen.getByRole("checkbox", { name: "Start pi in it" });
		expect(start.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(start);
		expect(start.getAttribute("aria-checked")).toBe("false");
		fireEvent.change(document.querySelector<HTMLInputElement>("[data-worktree-base]")!, { target: { value: "main" } });
		fireEvent.keyDown(branch, { key: "Enter" });
		await waitFor(() => expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("already exists"));

		// The refusal leaves the dialog ready for another try (on success, its owner closes it).
		fireEvent.change(branch, { target: { value: "feature/b" } });
		fireEvent.click(document.querySelector("[data-worktree-submit]")!);
		await waitFor(() => expect(requests).toEqual([
			{ branch: "feature/a", base: "main", startAgent: false },
			{ branch: "feature/b", base: "main", startAgent: false },
		]));
		expect(document.querySelector("[data-dialog-error]")).toBeNull();
		expect(document.querySelector("[data-worktree-submit]")!.textContent).toBe("Creating…");
		// Busy: Escape does not cancel what is in flight.
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onCancel).not.toHaveBeenCalled();
	});
});

describe("New Worktree, cancelled", () => {
	it("cancels with Escape", () => {
		const onCancel = vi.fn();
		render(<NewWorktreeDialog projectName="atlas" onCreate={async () => {}} onCancel={onCancel} />);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

describe("Add Project", () => {
	it("completes a folder on a click, and cancels with Escape", async () => {
		const onCancel = vi.fn();
		const listFolders = async (dir: string) => (dir === "/home/me" ? ["Code"] : dir === "/home/me/Code" ? ["pika"] : []);
		render(<AddProjectDialog nodeName="mac" home="/home/me" listFolders={listFolders} onAdd={async () => {}} onCancel={onCancel} />);
		expect(screen.getByRole("dialog", { name: "Add a project on mac" })).toBeTruthy();
		const field = document.querySelector<HTMLInputElement>("[data-add-project-path]")!;
		await waitFor(() => expect(document.activeElement).toBe(field));
		expect(field.getAttribute("role")).toBe("combobox");
		fireEvent.click(await screen.findByRole("option", { name: "Code/" }));
		expect(field.value).toBe("~/Code/");
		await screen.findByRole("option", { name: "pika/" });
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

describe("the undo notice", () => {
	it("says so in place when the undo fails, and offers no second Undo", async () => {
		const done = vi.fn();
		render(<UndoToast notice={{ id: 3, message: "Removed repo from Deck", undo: () => Promise.reject(new Error("node is offline")) }} onDone={done} />);
		const toast = document.querySelector<HTMLElement>("[data-undo-notice]")!;
		fireEvent.click(document.querySelector<HTMLElement>("[data-undo]")!);
		await waitFor(() => expect(document.querySelector("[data-undo-notice]")!.textContent).toBe("Undo failed: node is offline"));
		expect(document.querySelector("[data-undo]")).toBeNull();
		expect(toast.isConnected).toBe(true);
		expect(done).not.toHaveBeenCalled();
	});

	it("is replaced by a newer notice without that one being dismissed, under StrictMode too", async () => {
		const done = vi.fn();
		let show: (notice: UndoNotice) => void = () => {};
		function Owner() {
			const [notice, setNotice] = useState<UndoNotice | null>({ id: 1, message: "Removed alpha from Deck", undo: () => {} });
			show = setNotice;
			return notice && <UndoToast key={notice.id} notice={notice} onDone={() => (done(notice.id), setNotice(null))} />;
		}
		render(
			<StrictMode>
				<Owner />
			</StrictMode>,
		);
		await waitFor(() => expect(document.querySelector("[data-undo-notice]")?.textContent).toContain("Removed alpha"));
		act(() => show({ id: 2, message: "Removed beta from Deck", undo: () => {} }));
		await waitFor(() => expect(document.querySelector("[data-undo-notice]")?.textContent).toContain("Removed beta"));
		expect(done).not.toHaveBeenCalled();
	});

	it("closes on its own after five seconds", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const done = vi.fn();
			render(<UndoToast notice={{ id: 4, message: "Removed", undo: () => {} }} onDone={done} />);
			act(() => vi.advanceTimersByTime(4_900));
			expect(done).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(200));
			expect(done).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the shortcuts dialog", () => {
	it("is named by its title, focuses Close, and closes on Escape", async () => {
		const onClose = vi.fn();
		render(<KeysHelp onClose={onClose} />);
		const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
