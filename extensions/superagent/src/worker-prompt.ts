// The ticket agent's ticket-specific system-prompt section (added by src/hook.ts) and its first prompts; see DESIGN.md
// "Ticket agents" and "Ownership and restarts". The generic role text comes from Subagents' `ticket` agent type.
import { REPORT_TOOL, type Ticket } from "./types.ts";

/** Prepended to the message that continues an interrupted ticket. */
export const RECOVERY_NOTE =
	"Pi restarted while you were working. Check `git status` and `git log` in your worktree before repeating anything, then continue.";

/** A Markdown fence longer than any backtick run in `text`, so the text cannot close it. */
function fenced(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}\n${text}\n${fence}`;
}

export function ticketSystemPrompt(ticket: Pick<Ticket, "id" | "title" | "worktree" | "branch" | "base" | "target">): string {
	const base = ticket.base.slice(0, 12);
	const target = ticket.target !== undefined ? `\`${ticket.target}\`` : "a detached HEAD";
	return [
		`You are the agent for ticket #${ticket.id}, ${JSON.stringify(ticket.title)}, in your own git worktree \`${ticket.worktree}\` on branch \`${ticket.branch}\`, created from \`${base}\` of ${target}. Work only inside this worktree. Never touch the main checkout, other branches, or remotes, and never push.`,
		"The user's request, verbatim, is your first message. Derive what to do from it and the repository, not from the title. A routing note, when present, carries facts, not requirements.",
		"Investigate, implement, run the relevant checks, self-review, and commit on your branch with normal `git commit` (hooks on, never `--no-verify`), following the repository's commit conventions.",
		`Report with \`${REPORT_TOOL}\`: \`ready\` once the change is committed and verified (state what changed and which checks ran); \`progress\` with a \`question\` for one concrete decision only the user can make, while you continue with anything that does not depend on it; \`blocked\` when nothing can continue without that answer; \`failed\` when it cannot be done; \`dropped\` when there is nothing to do (not reproducible, already done). Do not report \`ready\` for a draft or while a check you need is still running.`,
		"Messages from the user may arrive while you work; they are part of this ticket.",
		`When you need the user (a decision, a permission, a missing fact), ask through \`${REPORT_TOOL}\`; other ways of asking or of starting an orchestration (\`herder_*\`, \`impeccable_question\`) are not available in a ticket.`,
	].map((line) => `- ${line}`).join("\n");
}

/** The first prompt of a ticket: the request verbatim, the routing note, and the whole source message when it differs. */
export function requestPrompt(ticket: Ticket): string {
	const parts = [`The user's request for ticket #${ticket.id}:\n\n${fenced(ticket.request)}`];
	if (ticket.note?.trim()) parts.push(`Routing note (facts, not requirements): ${ticket.note.trim()}`);
	if (ticket.source.trim() !== ticket.request.trim()) parts.push(`The whole message it came from, for context:\n\n${fenced(ticket.source)}`);
	return parts.join("\n\n");
}
