import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "../../components/icons";
import { cx } from "../../components/ui";
import { homePath, orderTerminals, paneLabel, type NodeView } from "../client";
import { sanitize, type Project, type TerminalInfo } from "../contract";
import { paneMark, StatusGlyph } from "./status";
import { OTHER } from "./store";
import { projectName } from "./projects";

export interface ProjectCard {
	project: string;
	terminals: TerminalInfo[];
}

/**
 * A ready node's project cards: projects with agents (in the node's order, "Other" last), then the project on screen
 * if it has none; and the rest of the node's projects, which open an empty workspace.
 */
export function projectCards(projects: readonly Project[], terminals: readonly TerminalInfo[], projectOf: (terminal: TerminalInfo) => string, active: string | undefined): { cards: ProjectCard[]; rest: Project[] } {
	const byProject = new Map<string, TerminalInfo[]>();
	for (const terminal of orderTerminals(terminals)) {
		const project = projectOf(terminal);
		byProject.set(project, [...(byProject.get(project) ?? []), terminal]);
	}
	const order = [...projects.map((item) => item.path), ...[...byProject.keys()].filter((path) => path !== OTHER && !projects.some((item) => item.path === path)), OTHER];
	const cards = order.filter((path) => byProject.has(path) || path === active).map((project) => ({ project, terminals: byProject.get(project) ?? [] }));
	// Waiting agents bring their card to the top.
	const waiting = (card: ProjectCard) => card.terminals.some((terminal) => terminal.status?.state === "waiting");
	return { cards: [...cards.filter(waiting), ...cards.filter((card) => !waiting(card))], rest: projects.filter((item) => !cards.some((card) => card.project === item.path)) };
}

export interface AgentRailProps {
	view: NodeView;
	projects: readonly Project[] | undefined;
	home: string;
	projectOf: (terminal: TerminalInfo) => string;
	/** The project on screen, when this node is. */
	activeProject?: string;
	/** The pane focused on screen. */
	activeTerminal?: string;
	onProject: (project: string) => void;
	onPane: (project: string, terminalId: string) => void;
}

/** One ready node's projects and their agents. */
export function NodeProjects({ view, projects, home, projectOf, activeProject, activeTerminal, onProject, onPane }: AgentRailProps) {
	const [more, setMore] = useState(false);
	if (!projects) return <p className="py-1 pr-4 pl-8 text-[12px] text-muted" role="status">Listing projects…</p>;
	const { cards, rest } = projectCards(projects, view.terminals, projectOf, activeProject);
	return (
		<div className="mb-2" data-node-projects={view.info.id}>
			{cards.length === 0 && <p className="py-1 pr-4 pl-8 text-[12px] text-muted">No terminals yet.</p>}
			{cards.map((card) => (
				<section key={card.project} aria-label={projectName(projects, card.project)} data-project-card={card.project}>
					<CardButton current={card.project === activeProject} onClick={() => onProject(card.project)} title={card.project === OTHER ? "Terminals in no project" : card.project}>
						<Icon name="folder" size={13} className="shrink-0 text-muted" />
						<span className="min-w-0 flex-1 truncate">
							<span className="font-medium">{projectName(projects, card.project)}</span>
							{card.project !== OTHER && <span className="ml-1.5 text-[11.5px] text-muted">{homePath(sanitize(card.project), home)}</span>}
						</span>
						{card.terminals.length > 0 && <span className="shrink-0 text-[11.5px] text-muted tabular-nums">{card.terminals.length}</span>}
					</CardButton>
					{card.terminals.length > 0 && (
						<ul aria-label={`Agents in ${projectName(projects, card.project)}`}>
							{card.terminals.map((terminal) => {
								const mark = paneMark(terminal);
								const current = card.project === activeProject && terminal.terminalId === activeTerminal;
								return (
									<li key={terminal.terminalId} data-terminal={terminal.terminalId} data-pane-state={mark}>
										<button
											type="button"
											aria-current={current ? "true" : undefined}
											className={cx(
												"flex w-full items-center gap-2 py-1 pr-4 pl-10 text-left text-[13px] hover:bg-hover",
												current && "bg-hover font-medium shadow-[inset_3px_0_0_var(--color-ink)]",
												terminal.exited && "text-muted",
											)}
											title={terminal.cwd}
											onClick={() => onPane(card.project, terminal.terminalId)}
											data-agent-row={terminal.terminalId}
										>
											<StatusGlyph mark={mark} />
											<span className="min-w-0 flex-1 truncate">{paneLabel(terminal)}</span>
											<AgentDetail terminal={terminal} />
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</section>
			))}
			{rest.length > 0 && (
				<>
					<button
						type="button"
						className="flex w-full items-center gap-1.5 py-1 pr-4 pl-8 text-left text-[12px] text-muted hover:text-ink"
						aria-expanded={more}
						onClick={() => setMore(!more)}
						data-more-projects=""
					>
						<span className="w-2.5 text-center text-[10px]" aria-hidden="true">
							{more ? "▾" : "▸"}
						</span>
						{more ? "Fewer projects" : `${rest.length} more ${rest.length === 1 ? "project" : "projects"}`}
					</button>
					{more &&
						rest.map((project) => (
							<CardButton key={project.path} current={false} onClick={() => onProject(project.path)} title={project.path} quiet>
								<Icon name="folder" size={13} className="shrink-0 text-muted" />
								<span className="min-w-0 flex-1 truncate">
									{sanitize(project.name)}
									<span className="ml-1.5 text-[11.5px] text-muted">{homePath(sanitize(project.path), home)}</span>
								</span>
							</CardButton>
						))}
				</>
			)}
		</div>
	);
}

function CardButton({ current, onClick, title, quiet, children }: { current: boolean; onClick: () => void; title: string; quiet?: boolean; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-current={current ? "true" : undefined}
			className={cx("flex w-full items-center gap-2 py-1 pr-4 pl-6 text-left text-[13px] hover:bg-hover", current && "bg-hover", quiet && "text-muted")}
			title={title}
			onClick={onClick}
			data-project-open=""
		>
			{children}
		</button>
	);
}

/** What a waiting agent asks for, or that it finished unseen. */
function AgentDetail({ terminal }: { terminal: TerminalInfo }) {
	const status = terminal.status;
	if (terminal.exited) return <span className="shrink-0 text-[11.5px] text-muted">Exited</span>;
	if (status?.state === "waiting") {
		const kind = status.program?.kind;
		return (
			<span className="shrink-0 text-[11.5px] font-medium" title={status.program?.message}>
				{kind === "permission" ? "Needs permission" : kind === "auth" ? "Needs login" : "Waiting"}
			</span>
		);
	}
	if (status?.state === "idle" && status.unread) return <span className="shrink-0 text-[11.5px] font-medium">Done</span>;
	return null;
}

/** A node's line in the rail. */
export function NodeLine({ view, current, label }: { view: NodeView; current: boolean; label: ReactNode }) {
	return (
		<Link
			to={`/nodes/${encodeURIComponent(view.info.id)}`}
			aria-current={current ? "page" : undefined}
			className={cx("flex items-center gap-2 px-4 py-1.5 hover:bg-hover", current && "font-medium")}
		>
			<span className={cx("size-2 shrink-0 rounded-full", view.info.online ? "bg-ink" : "border border-muted")} aria-hidden="true" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13.5px] font-medium">{view.info.name}</span>
				<span className="block truncate text-[11.5px] text-muted">{view.info.online ? (view.info.host ?? "Online") : "Offline"}</span>
			</span>
			{label}
		</Link>
	);
}
