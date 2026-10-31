import { Icon } from "../components/icons";
import { Tag } from "../components/Tag";
import { cx } from "../components/ui";
import { childLabel } from "../lib/labels";
import type { ChildSession } from "../lib/types";
import { KindBullet } from "../trace/parts";
import type { FamilyNode, FamilyTree } from "./model";

export type Kind = "main" | "subagent" | "herder";

/**
 * Each kind's timing bar: a subagent is the agent record kind, so its bar is the agent line colour; a main session and
 * a Herder step are not record kinds, so theirs are ink.
 */
export const KIND_CLASSES: Record<Kind, { bar: string }> = {
	main: { bar: "bg-ink" },
	subagent: { bar: "bg-k-agent" },
	herder: { bar: "bg-ink" },
};

/** A session's mark: the agent bullet where a subagent starts, the Herder mark for a step, a page for a main session. */
export function KindIcon({ kind }: { kind: Kind }) {
	if (kind === "subagent") return <KindBullet family="agent" />;
	return (
		<span className="flex size-4 shrink-0 items-center justify-center text-ink" aria-hidden="true">
			<Icon name={kind === "herder" ? "herder" : "message"} size={13} />
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

/** A branch's line: the agent line colour toward a subagent, ink toward a Herder step, which is no record kind. */
export type LineTone = "agent" | "ink";

const LINE_TONES: Record<LineTone, string> = { agent: "border-k-agent", ink: "border-ink" };

function toneOf(node: FamilyNode | undefined): LineTone {
	return node && sessionLabel(node.session, false).kind === "herder" ? "ink" : "agent";
}

/**
 * The tones of a row's lines, matching `continuesAt`: at each level the trunk's, which leads on to the next sibling
 * there; the row's own branch, which leads to the row; and the stub down to its first child.
 */
export function lineTones(family: FamilyTree, node: FamilyNode): { trunks: LineTone[]; own: LineTone; stub: LineTone } {
	const trunks: LineTone[] = [];
	for (let at: FamilyNode | undefined = node; at && trunks.length < node.depth; ) {
		const parent: FamilyNode | undefined = at.parentId ? family.byId.get(at.parentId) : undefined;
		if (!parent) break;
		const next = parent.children[parent.children.indexOf(at.id) + 1];
		trunks.unshift(toneOf(next ? family.byId.get(next) : at));
		at = parent;
	}
	return { trunks, own: toneOf(node), stub: toneOf(family.byId.get(node.children[0] ?? "")) };
}

/**
 * The lines left of a row, drawn like `tree` with rounded corners: one column per level below the root, each with its
 * line under the caret of the ancestor at that level. `continues` comes from `continuesAt`: a level whose later sibling
 * follows keeps its trunk; the last column holds the row's own branch, which leaves its trunk `elbow` px below the top
 * of the row and ends `reach` px into the row's own caret column (past it, for a leaf's empty one). `tones` comes from
 * `lineTones`.
 */
export function TreeLines({
	continues,
	elbow,
	reach,
	tones,
}: {
	continues: boolean[];
	elbow: number;
	reach: number;
	tones: { trunks: LineTone[]; own: LineTone };
}) {
	return continues.map((more, i) => {
		const own = i === continues.length - 1;
		return (
			<span key={i} className="relative shrink-0 self-stretch" style={{ width: TREE_INDENT }} aria-hidden="true" data-tree-level={own ? (more ? "tee" : "end") : more ? "trunk" : ""}>
				{more && <span className={cx("absolute inset-y-0 border-l", LINE_TONES[tones.trunks[i] ?? "agent"])} style={{ left: TRUNK }} />}
				{own && (
					<span
						className={cx("absolute top-0 rounded-bl-[7px] border-b border-l", LINE_TONES[tones.own])}
						style={{ left: TRUNK, height: elbow + 0.5, width: TREE_INDENT - TRUNK + reach }}
					/>
				)}
			</span>
		);
	});
}

/** The line from an open row's caret down to its first child, `from` px below the top of the row. */
export function TreeStub({ from, tone }: { from: number; tone: LineTone }) {
	return <span className={cx("absolute bottom-0 border-l", LINE_TONES[tone])} style={{ left: TRUNK, top: from }} aria-hidden="true" data-tree-stub="" />;
}

/** A session's kind as a small ink tag: `main`, its agent type, or its Herder role. */
export function KindPill({ kind, children }: { kind: Kind; children: string }) {
	return (
		<Tag icon={kind === "herder" ? "herder" : undefined}>
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
