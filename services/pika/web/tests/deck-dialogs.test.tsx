import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { KeysHelp } from "../src/nodes/KeysHelp";
import { NodeRequestError } from "../src/nodes/channel";
import { AddCheckoutDialog, CheckoutSettingsDialog, ConfirmDialog, NewWorktreeDialog, RemoveWorktreeDialog, settingsFrom, UndoToast, type UndoNotice } from "../src/nodes/deck/RailDialogs";
import { gitCheckout } from "./support/checkouts";

const ATLAS = gitCheckout("a", "/home/me/code/atlas");

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
	it("asks for a branch, shows the branch and folder it makes, creates with Enter, can leave pi out, and shows git's refusal in place", async () => {
		const requests: unknown[] = [];
		const onCreate = vi.fn(async (request: unknown) => {
			requests.push(request);
			if (requests.length === 1) throw new Error("exists: a branch named 'feature/a' already exists");
		});
		const onCancel = vi.fn();
		render(<NewWorktreeDialog projectName="atlas" checkout={ATLAS} home="/home/me" onCreate={onCreate} onCancel={onCancel} />);
		expect(screen.getByRole("dialog", { name: "New worktree of atlas" }).getAttribute("aria-modal")).toBe("true");
		const name = document.querySelector<HTMLInputElement>("[data-worktree-name]")!;
		await waitFor(() => expect(document.activeElement).toBe(name));
		fireEvent.keyDown(name, { key: "Enter" });
		expect(document.querySelector("[data-dialog-error]")!.textContent).toBe("Name the new branch");
		expect(onCreate).not.toHaveBeenCalled();
		// No setup script: nothing said about one.
		expect(document.querySelector("[data-worktree-setup]")).toBeNull();

		fireEvent.change(name, { target: { value: "feature/a" } });
		// The branch as typed; the folder beside the repository, as the node computes it.
		expect(document.querySelector("[data-worktree-branch-preview]")!.textContent).toBe("feature/a");
		expect(document.querySelector("[data-worktree-path-preview]")!.textContent).toBe("~/code/atlas-feature-a");
		const start = screen.getByRole("checkbox", { name: "Start pi in it" });
		expect(start.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(start);
		expect(start.getAttribute("aria-checked")).toBe("false");
		fireEvent.change(document.querySelector<HTMLInputElement>("[data-worktree-base]")!, { target: { value: "main" } });
		fireEvent.keyDown(name, { key: "Enter" });
		await waitFor(() => expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("already exists"));

		// The refusal leaves the dialog ready for another try (on success, its owner closes it).
		fireEvent.change(name, { target: { value: "feature/b" } });
		fireEvent.click(document.querySelector("[data-worktree-submit]")!);
		await waitFor(() =>
			expect(requests).toEqual([
				{ name: "feature/a", base: "main", startAgent: false },
				{ name: "feature/b", base: "main", startAgent: false },
			]),
		);
		expect(document.querySelector("[data-dialog-error]")).toBeNull();
		expect(document.querySelector("[data-worktree-submit]")!.textContent).toBe("Creating…");
		// Busy: Escape does not cancel what is in flight.
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("starts from the checkout's settings: its base, its folder, and says the setup script runs", async () => {
		const requests: unknown[] = [];
		const checkout = { ...ATLAS, settings: { worktreeLocation: "/srv/trees", worktreeBase: "origin/main", setupScript: "npm ci" } };
		render(<NewWorktreeDialog projectName="atlas" checkout={checkout} home="/home/me" onCreate={async (request) => void requests.push(request)} onCancel={() => {}} />);
		expect(document.querySelector<HTMLInputElement>("[data-worktree-base]")!.value).toBe("origin/main");
		expect(document.querySelector("[data-worktree-setup]")).not.toBeNull();
		const name = document.querySelector<HTMLInputElement>("[data-worktree-name]")!;
		fireEvent.change(name, { target: { value: "..." } });
		expect(document.querySelector("[data-worktree-path-preview]")!.textContent).toBe("—");
		fireEvent.keyDown(name, { key: "Enter" });
		expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("letter or a digit");
		fireEvent.change(name, { target: { value: "Fix #12: login" } });
		expect(document.querySelector("[data-worktree-path-preview]")!.textContent).toBe("/srv/trees/atlas-Fix-12-login");
		// A base cleared by hand is HEAD, as the field shows, not the setting.
		fireEvent.change(document.querySelector<HTMLInputElement>("[data-worktree-base]")!, { target: { value: "" } });
		fireEvent.keyDown(name, { key: "Enter" });
		await waitFor(() => expect(requests).toEqual([{ name: "Fix #12: login", base: "HEAD", startAgent: true }]));
	});
});

describe("New Worktree, cancelled", () => {
	it("cancels with Escape", () => {
		const onCancel = vi.fn();
		render(<NewWorktreeDialog projectName="atlas" checkout={ATLAS} home="/home/me" onCreate={async () => {}} onCancel={onCancel} />);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

describe("Remove Worktree", () => {
	const refuse = (code: string, message: string) => new NodeRequestError({ code, message });

	it("keeps the branch unless asked, offers to stop the terminals the node says use it, and shows git's refusal", async () => {
		const requests: unknown[] = [];
		const answers: (Error | undefined)[] = [refuse("busy", "2 terminals use /home/me/code/atlas-fix"), refuse("conflict", "fatal: '/home/me/code/atlas-fix' contains modified or untracked files, use --force to delete it"), undefined];
		const onRemove = vi.fn(async (request: unknown) => {
			requests.push(request);
			const answer = answers.shift();
			if (answer) throw answer;
		});
		render(<RemoveWorktreeDialog nodeName="mac" path="/home/me/code/atlas-fix" home="/home/me" branch="fix" prunable={false} liveTerminals={0} onRemove={onRemove} onCancel={() => {}} />);
		const dialog = screen.getByRole("alertdialog", { name: "Remove the worktree fix?" });
		expect(dialog.textContent).toContain("~/code/atlas-fix");
		const deleteBranch = screen.getByRole("checkbox", { name: "Also delete branch fix" });
		expect(deleteBranch.getAttribute("aria-checked")).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "Remove Worktree" }));
		// Busy: the node's count, and the offer.
		await screen.findByRole("button", { name: "Stop 2 terminals and Remove" });
		expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("2 terminals");
		fireEvent.click(deleteBranch);
		fireEvent.click(screen.getByRole("button", { name: "Stop 2 terminals and Remove" }));
		await waitFor(() => expect(document.querySelector("[data-dialog-error]")!.textContent).toContain("modified or untracked files"));
		// git ran, so the forced try stopped the terminals: no more offer to stop them.
		fireEvent.click(screen.getByRole("button", { name: "Remove Worktree" }));
		await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(3));
		expect(requests).toEqual([
			{ deleteBranch: false, force: false },
			{ deleteBranch: true, force: true },
			{ deleteBranch: true, force: false },
		]);
	});

	it("counts the terminals it knows of, and says a prunable worktree's folder is gone; a detached one has no branch to delete", async () => {
		const onRemove = vi.fn(async () => {
			throw refuse("busy", "terminals use it");
		});
		render(<RemoveWorktreeDialog nodeName="mac" path="/home/me/code/atlas-old" home="/home/me" prunable liveTerminals={1} onRemove={onRemove} onCancel={() => {}} />);
		expect(screen.getByRole("alertdialog").textContent).toContain("is gone");
		expect(screen.queryByRole("checkbox")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Remove Worktree" }));
		await screen.findByRole("button", { name: "Stop 1 terminal and Remove" });
	});
});

describe("Worktree settings", () => {
	it("reads the fields: empty is the default, ~ is the home, and each is checked", () => {
		expect(settingsFrom({ location: "", base: "", script: "  " }, "/home/me")).toEqual({});
		expect(settingsFrom({ location: "~/trees/", base: " origin/main ", script: "npm ci\nnpm run build" }, "/home/me")).toEqual({
			worktreeLocation: "/home/me/trees",
			worktreeBase: "origin/main",
			setupScript: "npm ci\nnpm run build",
		});
		expect(settingsFrom({ location: "trees", base: "", script: "" }, "/home/me")).toMatch(/absolute path/);
		expect(settingsFrom({ location: "", base: "a\tb", script: "" }, "/home/me")).toMatch(/one line/);
		expect(settingsFrom({ location: "", base: "", script: "echo \u0007" }, "/home/me")).toMatch(/control character/);
	});

	it("saves the settings whole and shows the node's refusal", async () => {
		const saved: unknown[] = [];
		const onSave = vi.fn(async (settings: unknown) => {
			saved.push(settings);
			if (saved.length === 1) throw refuseSettings();
		});
		const checkout = { ...ATLAS, settings: { worktreeBase: "origin/main" } };
		render(<CheckoutSettingsDialog checkoutName="atlas" checkout={checkout} home="/home/me" onSave={onSave} onCancel={() => {}} />);
		expect(screen.getByRole("dialog", { name: "Worktree settings of atlas" })).toBeTruthy();
		expect(document.querySelector<HTMLInputElement>("[data-settings-location]")!.placeholder).toBe("~/code");
		expect(document.querySelector<HTMLInputElement>("[data-settings-base]")!.value).toBe("origin/main");
		fireEvent.change(document.querySelector<HTMLInputElement>("[data-settings-location]")!, { target: { value: "~/missing" } });
		fireEvent.change(document.querySelector<HTMLTextAreaElement>("[data-settings-script]")!, { target: { value: "npm ci" } });
		fireEvent.click(document.querySelector("[data-settings-save]")!);
		await waitFor(() => expect(document.querySelector("[data-dialog-error]")!.textContent).toBe("not_found: no directory /home/me/missing"));
		fireEvent.change(document.querySelector<HTMLInputElement>("[data-settings-location]")!, { target: { value: "" } });
		fireEvent.click(document.querySelector("[data-settings-save]")!);
		await waitFor(() => expect(saved).toHaveLength(2));
		expect(saved).toEqual([
			{ worktreeLocation: "/home/me/missing", worktreeBase: "origin/main", setupScript: "npm ci" },
			{ worktreeBase: "origin/main", setupScript: "npm ci" },
		]);
	});

	const refuseSettings = () => new NodeRequestError({ code: "not_found", message: "no directory /home/me/missing" });
});

describe("Add Repository", () => {
	it("completes a folder on a click, and cancels with Escape", async () => {
		const onCancel = vi.fn();
		const listFolders = async (dir: string) => (dir === "/home/me" ? ["Code"] : dir === "/home/me/Code" ? ["pika"] : []);
		render(<AddCheckoutDialog nodeName="mac" home="/home/me" listFolders={listFolders} onAdd={async () => {}} onCancel={onCancel} />);
		expect(screen.getByRole("dialog", { name: "Add a repository on mac" })).toBeTruthy();
		const field = document.querySelector<HTMLInputElement>("[data-add-checkout-path]")!;
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

	it("only says what happened when there is nothing to undo", () => {
		render(<UndoToast notice={{ id: 5, message: "Removed the worktree and the branch fix" }} onDone={() => {}} />);
		expect(document.querySelector("[data-undo-notice]")!.textContent).toBe("Removed the worktree and the branch fix");
		expect(document.querySelector("[data-undo]")).toBeNull();
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
