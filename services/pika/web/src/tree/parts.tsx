import { Icon, type IconName } from "../components/icons";
import { colorOf, Tag, tagColorClasses, type TagColor } from "../components/Tag";
import { cx } from "../components/ui";
import { childLabel } from "../lib/labels";
import type { ChildSession } from "../lib/types";
import type { FamilyNode } from "./model";

export type Kind = "main" | "subagent" | "herder";

/** The trajectory palette's color of each kind, for the agent tree's timeline bars. */
export const KIND_CLASSES: Record<Kind, { bar: string }> = {
	main: { bar: "bg-k-user" },
	subagent: { bar: "bg-k-agent" },
	herder: { bar: "bg-k-shell" },
};

/** The fleet's agents and Herder's roles keep one color each; any other agent type gets its own from its name. */
const TYPE_COLORS: Record<string, TagColor> = {
	main: "blue",
	recon: "green",
	worker: "purple",
	reviewer: "pink",
	expert: "yellow",
	planner: "brown",
	implementer: "purple",
	verifier: "green",
	subagent: "gray",
};

/** A kind of agent's tag color: a Herder step's is its role's. */
export function typeColor(type: string): TagColor {
	const role = type.replace(/ step$/, "");
	return TYPE_COLORS[role] ?? colorOf(role);
}

const KIND_ICONS: Record<Kind, IconName> = { main: "message", subagent: "agent", herder: "herder" };

/** A session's page icon, in its kind's color. */
export function KindIcon({ kind, type }: { kind: Kind; type: string }) {
	return (
		<span className={cx("flex size-5 shrink-0 items-center justify-center rounded-[5px]", tagColorClasses(typeColor(type)))} aria-hidden="true">
			<Icon name={KIND_ICONS[kind]} size={12} />
		</span>
	);
}

/**
 * The kind, tag text, and description of a session; a `top` one without a link is a main session. The public view
 * has no links, so children read as subagents. A subagent's description says what it was asked to do; a step has none,
 * so its title (its first prompt) does, rather than its task's id.
 */
export function sessionLabel(session: ChildSession, top: boolean): { kind: Kind; type: string; description: string } {
	const link = session.link;
	if (!link && top) return { kind: "main", type: "main", description: session.title || "Untitled session" };
	const { type, description } = childLabel(session);
	return {
		kind: link?.kind === "herder-step" || link?.herder ? "herder" : "subagent",
		type,
		description: link?.description || session.title || description || "Untitled session",
	};
}

export function rowLabel(node: FamilyNode): { kind: Kind; type: string; description: string } {
	return sessionLabel(node.session, node.depth === 0);
}

/** One level of the tree's indent. */
export const TREE_INDENT = 24;
/** Where a column's line runs: under the middle of the 18px caret column of the row one level up. */
const TRUNK = 9;
/** The lines' color: stronger than `border-line`, so the branches read at a glance. */
const LINE = "border-muted/45";

/**
 * The lines left of a row, drawn like `tree` with rounded corners: one column per level below the root, each with its
 * line under the caret of the ancestor at that level. `continues` comes from `continuesAt`: a level whose later sibling
 * follows keeps its trunk; the last column holds the row's own branch, which leaves its trunk `elbow` px below the top
 * of the row and ends `reach` px into the row's own caret column (past it, for a leaf's empty one).
 */
export function TreeLines({ continues, elbow, reach }: { continues: boolean[]; elbow: number; reach: number }) {
	return continues.map((more, i) => {
		const own = i === continues.length - 1;
		return (
			<span key={i} className="relative shrink-0 self-stretch" style={{ width: TREE_INDENT }} aria-hidden="true" data-tree-level={own ? (more ? "tee" : "end") : more ? "trunk" : ""}>
				{more && <span className={cx("absolute inset-y-0 border-l", LINE)} style={{ left: TRUNK }} />}
				{own && (
					<span
						className={cx("absolute top-0 rounded-bl-[7px] border-b border-l", LINE)}
						style={{ left: TRUNK, height: elbow + 0.5, width: TREE_INDENT - TRUNK + reach }}
					/>
				)}
			</span>
		);
	});
}

/** The line from an open row's caret down to its first child, `from` px below the top of the row. */
export function TreeStub({ from }: { from: number }) {
	return <span className={cx("absolute bottom-0 border-l", LINE)} style={{ left: TRUNK, top: from }} aria-hidden="true" data-tree-stub="" />;
}

export function KindPill({ kind, children }: { kind: Kind; children: string }) {
	return (
		<Tag color={typeColor(children)} icon={kind === "herder" ? "herder" : undefined}>
			{children}
		</Tag>
	);
}

/**
 * Opens or closes a row's children. Inside the agent tree it takes no focus, so the tree's keys keep working;
 * elsewhere pass `focusable`.
 */
export function Caret({ open, onClick, label, focusable = false }: { open: boolean; onClick: () => void; label?: string; focusable?: boolean }) {
	const action = open ? "Collapse" : "Expand";
	return (
		<button
			type="button"
			tabIndex={focusable ? undefined : -1}
			aria-label={label ? `${action} ${label}` : action}
			aria-expanded={focusable ? open : undefined}
			onMouseDown={focusable ? undefined : (event) => event.preventDefault()}
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			}}
			className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-ink"
			data-tree-toggle=""
		>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={cx("transition-transform duration-150", open && "rotate-90")}>
				<path d="M3.5 2 7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</button>
	);
}
