/** The Nodes page's pane sizes, kept per browser. */
export interface NodesLayout {
	/** The agent list on the left. */
	rail: number;
	/** The file panel on the right. */
	files: number;
	/** The file tree inside the file panel. */
	tree: number;
	filesOpen: boolean;
	/** Dotfiles in the tree. */
	hidden: boolean;
	/** What the file panel's left column lists: the tree, or git's changes. */
	sidebar: "files" | "changes";
	/** Diffs one column above the other, rather than side by side. */
	diffInline: boolean;
}

export const LAYOUT_KEY = "pika.nodes.layout";

export const LAYOUT_DEFAULTS: NodesLayout = { rail: 288, files: 640, tree: 220, filesOpen: true, hidden: false, sidebar: "files", diffInline: false };

/** Least and most width of each pane, in CSS pixels. */
export const LAYOUT_BOUNDS = {
	rail: [200, 480],
	files: [320, 1600],
	tree: [140, 560],
} as const satisfies Record<"rail" | "files" | "tree", readonly [number, number]>;

export const clampWidth = (pane: keyof typeof LAYOUT_BOUNDS, value: number): number => {
	const [min, max] = LAYOUT_BOUNDS[pane];
	return Math.round(Math.min(max, Math.max(min, value)));
};

/** The stored layout; a missing, unreadable, or out-of-range value falls back to its default. */
export function loadLayout(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): NodesLayout {
	let stored: Partial<Record<keyof NodesLayout, unknown>> = {};
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? "{}");
		if (parsed && typeof parsed === "object") stored = parsed as typeof stored;
	} catch {
		// Unreadable: the defaults.
	}
	const width = (pane: keyof typeof LAYOUT_BOUNDS) => {
		const value = stored[pane];
		return typeof value === "number" && Number.isFinite(value) ? clampWidth(pane, value) : LAYOUT_DEFAULTS[pane];
	};
	const flag = (name: "filesOpen" | "hidden" | "diffInline") => (typeof stored[name] === "boolean" ? (stored[name] as boolean) : LAYOUT_DEFAULTS[name]);
	const sidebar = stored.sidebar === "changes" || stored.sidebar === "files" ? stored.sidebar : LAYOUT_DEFAULTS.sidebar;
	return {
		rail: width("rail"),
		files: width("files"),
		tree: width("tree"),
		filesOpen: flag("filesOpen"),
		hidden: flag("hidden"),
		sidebar,
		diffInline: flag("diffInline"),
	};
}

export function saveLayout(layout: NodesLayout, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
	try {
		storage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
	} catch {
		// Private browsing or a full quota: the layout lasts for this page only.
	}
}
