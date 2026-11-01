import { linkTicket } from "./tickets";
import type { ChildSession } from "./types";

/** A child session's kind of agent and what it was asked to do. */
export function childLabel(child: ChildSession): { type: string; description: string } {
	const link = child.link;
	const type = link?.herder ? `${link.herder.role} step` : (link?.agentType ?? (link?.kind === "herder-step" ? "herder step" : "subagent"));
	// A ticket's description repeats its number, which its badge shows; its title says what it is about.
	const ticket = linkTicket(link);
	return { type, description: ticket?.title ?? link?.description ?? link?.herder?.task ?? child.title ?? "Untitled session" };
}
