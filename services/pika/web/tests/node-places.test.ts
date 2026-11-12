import { describe, expect, it } from "vitest";
import { makesWorktrees, placeKey, placeOfTerminal, placePath, placeWords, splitPlace, worktreePathFor, worktreeSlug } from "../src/nodes/workspace/places";
import { OTHER } from "../src/nodes/workspace/store";
import { cid, fakeKey, folderCheckout, gitCheckout, rail, worktree } from "./support/checkouts";

const row = (key: string, name: string | null, collapsed = false) => ({ key, name, collapsed, updatedAt: "2026-11-12T00:00:00Z" });

describe("places", () => {
	it("are a checkout and a worktree path, or Other", () => {
		const place = placeKey(cid("a"), "/home/me/repo-fix");
		expect(splitPlace(place)).toEqual({ checkoutId: cid("a"), worktreePath: "/home/me/repo-fix" });
		expect(placePath(place)).toBe("/home/me/repo-fix");
		expect(splitPlace(OTHER)).toBeUndefined();
		expect(placePath(OTHER)).toBeUndefined();
	});

	it("put a terminal where its node placed it, when that worktree is listed; else in Other", () => {
		const repo = gitCheckout("a", "/home/me/repo", { linked: [worktree("/home/me/repo-fix", "fix")] });
		const { places } = rail("mac", [repo]);
		expect(placeOfTerminal(places, { checkoutId: repo.id, worktreePath: "/home/me/repo-fix" })).toBe(placeKey(repo.id, "/home/me/repo-fix"));
		// A worktree the list does not hold (truncated, just removed), a hidden checkout, or none at all.
		expect(placeOfTerminal(places, { checkoutId: repo.id, worktreePath: "/home/me/repo-gone" })).toBe(OTHER);
		expect(placeOfTerminal(places, { checkoutId: cid("f"), worktreePath: "/srv" })).toBe(OTHER);
		expect(placeOfTerminal(places, {})).toBe(OTHER);
	});
});

describe("new worktrees' folders (Orca's sanitizeWorktreeName)", () => {
	it("turn each run of other characters into one -, dropping leading and trailing . and -", () => {
		expect(worktreeSlug("feature/login")).toBe("feature-login");
		expect(worktreeSlug("Fix #12: the  login")).toBe("Fix-12-the-login");
		expect(worktreeSlug("-.hidden.-")).toBe("hidden");
		expect(worktreeSlug("v1.2_rc")).toBe("v1.2_rc");
		expect(worktreeSlug("///")).toBe("");
	});

	it("go beside the main worktree, or in the checkout's worktreeLocation", () => {
		const repo = gitCheckout("a", "/home/me/code/atlas");
		expect(worktreePathFor(repo, "feature/a")).toBe("/home/me/code/atlas-feature-a");
		expect(worktreePathFor({ ...repo, settings: { worktreeLocation: "/srv/trees" } }, " feature/a ")).toBe("/srv/trees/atlas-feature-a");
		expect(worktreePathFor({ ...repo, settings: { worktreeLocation: "/" } }, "x")).toBe("/atlas-x");
		expect(worktreePathFor(repo, "...")).toBeUndefined();
	});
});

describe("a node's projects", () => {
	const repo = gitCheckout("a", "/home/me/repo", { linked: [worktree("/home/me/repo-fix", "fix"), worktree("/home/me/repo-old", undefined, { prunable: true })] });
	// A second clone of the same remote: one project, two checkouts.
	const clone = gitCheckout("b", "/home/me/src/repo", { name: "repo (src)", named: true });
	const fork = gitCheckout("c", "/home/me/fork", { repository: "https://github.com/someone/repo", project: "repo", name: "repo" });
	const notes = folderCheckout("d", "/home/me/notes");
	// A project name that is no valid one: the server answers no key.
	const odd = folderCheckout("e", "/home/me/odd", { project: "..", name: ".." });
	const keyOf = (item: { repository?: string; project?: string; node: string }) => (item.project === ".." ? null : fakeKey(item));

	it("group checkouts by the server's key, in the list's order: clones together, a fork apart, no key alone", () => {
		const node = rail("mac", [repo, clone, fork, notes, odd], [], keyOf);
		expect(node.projects.map((project) => project.id)).toEqual([
			"repo:https://github.com/me/repo",
			"repo:https://github.com/someone/repo",
			"local:notes@node:mac",
			`checkout:${odd.id}`,
		]);
		const [first, forked, folder, alone] = node.projects;
		expect(first!.checkouts.map((entry) => entry.checkout.id)).toEqual([repo.id, clone.id]);
		expect(first!.showPaths).toBe(true);
		expect(forked!.showPaths).toBe(false);
		// The heading is the first checkout's name while the server keeps none.
		expect(first!.name).toBe("repo");
		expect(first!.named).toBe(false);
		expect(alone!.serverKey).toBeNull();
		expect(folder!.serverKey).toBe("local:notes@node:mac");
		expect(folder!.repository).toBeUndefined();
	});

	it("name and fold a project as the server keeps it", () => {
		const node = rail("mac", [repo, clone], [row("repo:https://github.com/me/repo", "Atlas\u001b[31m", true)]);
		expect(node.projects[0]).toMatchObject({ name: "Atlas", named: true, collapsed: true });
	});

	it("join checkouts whose key is not known yet by repository, and leave others alone", () => {
		const node = rail("mac", [repo, clone, notes], [], () => undefined);
		expect(node.projects.map((project) => project.id)).toEqual(["pending:https://github.com/me/repo", `checkout:${notes.id}`]);
		expect(node.projects.every((project) => project.serverKey === null)).toBe(true);
	});

	it("make worktree cards: the main one first, branch as the meta line, a folder's own path", () => {
		const node = rail("mac", [repo, notes]);
		const cards = node.projects[0]!.checkouts[0]!.worktrees;
		expect(cards.map((card) => [card.title, card.meta, card.isMain, card.linked])).toEqual([
			["repo", "main", true, false],
			["repo-fix", "fix", false, true],
			["repo-old", "0123456", false, true],
		]);
		expect(cards[2]).toMatchObject({ detached: true, prunable: true, label: "0123456" });
		const folder = node.projects[1]!.checkouts[0]!.worktrees;
		expect(folder).toEqual([expect.objectContaining({ place: placeKey(notes.id, notes.path), title: "notes", isMain: true, linked: false })]);
		expect(folder[0]).not.toHaveProperty("meta");
		expect(placeWords(node.places.get(cards[1]!.place))).toBe("fix · repo");
		expect(placeWords(node.places.get(folder[0]!.place))).toBe("notes");
		expect(node.places.size).toBe(4);
		expect(makesWorktrees(repo)).toBe(true);
		expect(makesWorktrees(notes)).toBe(false);
		// A bare repository lists no main worktree.
		expect(makesWorktrees({ ...repo, worktrees: [worktree("/home/me/w", "w")] })).toBe(false);
	});
});
