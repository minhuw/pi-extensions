/*
 * Arrow-key navigation for the agent rail. Ported from T3 Code, `apps/web/src/lib/sidebarTree.ts` (MIT © 2026 T3 Tools
 * Inc., see T3-LICENSE), without its context-menu key handling, which the rail has no menu for, and with one addition:
 * a row whose folding is a separate control names it in `data-sidebar-toggle` (a selector within the row's parent).
 */

const ROW = "[data-sidebar-row]";

/**
 * Installs the rail's keyboard navigation on `root` and returns its cleanup. Arrow keys move focus between rows without
 * opening them, as in VS Code's list commands: Up and Down, Home and End; Right expands a collapsed row or goes to its
 * first child, Left collapses an expanded row or goes to its parent. Rows stay ordinary buttons in the Tab order so
 * screen readers can browse the list. A row names itself in `data-sidebar-row` and its parent in
 * `data-sidebar-parent`; an action beside a row names it in `data-sidebar-action-for`.
 */
export function installRailTree(root: HTMLElement): () => void {
	let focusedId: string | undefined;
	let focusedParent: string | undefined;
	let focusedIndex = -1;
	let ownsFocus = false;

	const isVisibleRow = (row: HTMLElement) => {
		const hidden = row.closest('[hidden], [inert], [aria-hidden="true"]');
		return (!hidden || !root.contains(hidden)) && !row.matches(":disabled");
	};
	const visibleRows = () => Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter(isVisibleRow);

	const ownerRow = (element: HTMLElement) => {
		const row = element.closest<HTMLElement>(ROW);
		if (row) return row;
		const linked = element.dataset.sidebarActionFor;
		return linked ? root.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(linked)}"]`) : null;
	};

	// The control that folds `row`: the row itself, or the one it names.
	const toggle = (row: HTMLElement) => {
		const selector = row.dataset.sidebarToggle;
		(selector ? (row.parentElement?.querySelector<HTMLElement>(selector) ?? row) : row).click();
	};

	const focusRow = (row: HTMLElement) => {
		// Revealing before focusing also draws content-visibility:auto rows.
		row.scrollIntoView({ block: "nearest" });
		row.focus({ preventScroll: true });
	};

	// A row that moves to another section remounts and drops focus to the body; follow it.
	const restoreFocus = () => {
		if (!ownsFocus || focusedId === undefined) return;
		const active = document.activeElement;
		const lost = active === document.body || (active instanceof HTMLElement && root.contains(active) && active.matches(ROW) && !isVisibleRow(active));
		if (!lost) return;
		const rows = visibleRows();
		const target =
			rows.find((row) => row.dataset.sidebarRow === focusedId) ??
			rows.find((row) => row.dataset.sidebarRow === focusedParent) ??
			rows[Math.min(Math.max(focusedIndex, 0), rows.length - 1)];
		target?.focus({ preventScroll: true });
	};

	// Clicking non-focusable content drops focus to the body without a focusin event.
	const onPointerDown = (event: PointerEvent) => {
		const focusable = event.target instanceof Element ? event.target.closest(`${ROW}, button, a[href], input, [tabindex]`) : null;
		ownsFocus = focusable !== null && root.contains(focusable);
	};
	const onFocus = (event: FocusEvent) => {
		ownsFocus = root.contains(event.target as Node);
		if (!ownsFocus || !(event.target instanceof HTMLElement)) return;
		const row = ownerRow(event.target);
		if (!row) return;
		focusedId = row.dataset.sidebarRow;
		focusedParent = row.dataset.sidebarParent;
		focusedIndex = visibleRows().indexOf(row);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const row = event.target;
		if (!(row instanceof HTMLElement) || !row.matches(ROW)) return;
		const rows = visibleRows();
		const index = rows.indexOf(row);
		if (index < 0) return;
		let target: HTMLElement | undefined;
		switch (event.key) {
			case "ArrowDown":
				target = rows[Math.min(index + 1, rows.length - 1)];
				break;
			case "ArrowUp":
				target = rows[Math.max(index - 1, 0)];
				break;
			case "Home":
				target = rows[0];
				break;
			case "End":
				target = rows.at(-1);
				break;
			case "ArrowRight":
				if (row.getAttribute("aria-expanded") === "false") toggle(row);
				else target = rows.find((candidate) => candidate.dataset.sidebarParent === row.dataset.sidebarRow);
				break;
			case "ArrowLeft":
				if (row.getAttribute("aria-expanded") === "true") toggle(row);
				else target = rows.find((candidate) => candidate.dataset.sidebarRow === row.dataset.sidebarParent);
				break;
			// Rows own Enter and Space.
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (target) focusRow(target);
	};
	const observer = new MutationObserver(restoreFocus);
	observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden"] });
	document.addEventListener("focusin", onFocus);
	document.addEventListener("pointerdown", onPointerDown, true);
	root.addEventListener("keydown", onKeyDown, true);
	return () => {
		observer.disconnect();
		document.removeEventListener("focusin", onFocus);
		document.removeEventListener("pointerdown", onPointerDown, true);
		root.removeEventListener("keydown", onKeyDown, true);
	};
}
