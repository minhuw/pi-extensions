import type { ChildSession } from "./types";

/** A child session's kind of agent and what it was asked to do. */
export function childLabel(child: ChildSession): { type: string; description: string } {
	const link = child.link;
	const type = link?.herder ? `${link.herder.role} step` : (link?.agentType ?? (link?.kind === "herder-step" ? "herder step" : "subagent"));
	return { type, description: link?.description ?? link?.herder?.task ?? child.title ?? "Untitled session" };
}
