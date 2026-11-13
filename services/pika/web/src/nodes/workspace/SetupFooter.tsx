/**
 * The footer under an exited setup script's terminal (`role: "setup"`, NODE.md "Terminals"): its pane stays open with
 * the last screen, and this says how the script ended and offers what comes next (DESIGN.deck.md, "Setup terminals").
 */
import { useState } from "react";
import { Button } from "../../components/ui-shadcn/button";
import type { TerminalInfo } from "../contract";
import { StatusGlyph, type PaneMark } from "./status";

export type SetupAction = "rerun" | "shell" | "close";

/** How a setup script ended, as the footer says it: exit 0 finished, another code failed, a signal stopped it. */
export function setupOutcome(exited: NonNullable<TerminalInfo["exited"]>): { mark: PaneMark; text: string } {
	if (exited.signal) return { mark: "exited", text: `Setup stopped (${exited.signal})` };
	if (exited.code !== null && exited.code !== 0) return { mark: "error", text: `Setup failed (exit ${exited.code})` };
	return { mark: "done", text: "Setup finished" };
}

const TONE: Partial<Record<PaneMark, string>> = { error: "text-dk-failed-ink", done: "text-dk-done-ink" };

export function SetupFooter({ exited, onAction }: { exited: NonNullable<TerminalInfo["exited"]>; onAction: (action: SetupAction) => Promise<void> }) {
	const [pending, setPending] = useState<SetupAction>();
	const { mark, text } = setupOutcome(exited);
	const act = (action: SetupAction) => {
		setPending(action);
		// The pane may go (Close) or show another terminal (Rerun, Open shell here), which unmounts this footer.
		void onAction(action).finally(() => setPending(undefined));
	};
	return (
		<div className="flex h-8 shrink-0 items-center gap-2 border-t border-dk-line bg-dk-chrome px-3 text-[12px]" data-setup-footer={mark}>
			<StatusGlyph mark={mark} />
			<span className={TONE[mark] ?? "text-dk-ink-2"} role="status" data-setup-outcome="">
				{text}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1">
				<Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={() => act("rerun")} data-setup-action="rerun">
					Rerun
				</Button>
				<Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={() => act("shell")} data-setup-action="shell">
					Open shell here
				</Button>
				<Button variant="ghost" size="sm" disabled={pending !== undefined} onClick={() => act("close")} data-setup-action="close">
					Close
				</Button>
			</span>
		</div>
	);
}
