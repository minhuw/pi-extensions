import { useId, useLayoutEffect } from "react";
import { formatBytes, sessionLabel, shortId } from "../../lib/relay";
import type { RelayRoom } from "../../lib/types";
import { Icon } from "../icons";
import { BUTTON, cx } from "../ui";
import { memberDevice } from "./helpers";
import { RepBadge } from "./primitives";
import type { DmThread, ReplyDraft, ThreadSelection } from "./types";
import type { ComposerController } from "./useComposer";

export function Composer({
	selection,
	activeRoom,
	activeDm,
	replyTo,
	onClearReply,
	composer,
}: {
	selection: ThreadSelection;
	activeRoom?: RelayRoom;
	activeDm?: DmThread;
	replyTo: ReplyDraft | null;
	onClearReply: () => void;
	composer: ComposerController;
}) {
	const composerId = useId();
	const notifyId = useId();

	useLayoutEffect(() => {
		const node = composer.inputRef.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, 240)}px`;
	}, [composer.text, composer.inputRef]);

	return (
		<div className="shrink-0 border-t border-ink bg-soft px-5 py-3 max-sm:px-4">
			{replyTo && (
				<div
					data-imessage-reply-banner={replyTo.id}
					className="mb-2 flex items-center gap-2 rounded-sm border border-line border-l border-l-ink bg-page px-3 py-1.5 text-[12.5px]"
				>
					<Icon name="reply" size={13} className="shrink-0 text-ink" />
					<span className="shrink-0 text-muted">Replying to</span>
					<span className="shrink-0 font-semibold text-ink">{replyTo.sender}</span>
					<span className="mono shrink-0 !text-[11.5px] text-muted">{shortId(replyTo.id)}</span>
					<span className="min-w-0 flex-1 truncate text-muted">{replyTo.preview}</span>
					<button
						type="button"
						onClick={onClearReply}
						aria-label="Cancel reply"
						data-imessage-cancel-reply=""
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink"
					>
						<Icon name="close" size={12} />
					</button>
				</div>
			)}

			{selection.kind === "room" && activeRoom && (
				<div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px]" data-imessage-mention-bar="">
					<span id={notifyId} className="mr-0.5 font-medium text-muted">
						Notify
					</span>
					<div role="group" aria-labelledby={notifyId} className="flex flex-wrap items-center gap-1.5">
						<button
							type="button"
							onClick={() => composer.onToggleMention("all")}
							data-imessage-mention="all"
							data-imessage-notify-chip="all"
							aria-pressed={composer.selectedMentions.has("all")}
							title="Every member of the room"
							className={cx(
								"inline-flex h-6 items-center gap-1 rounded-sm border px-2 font-medium",
								composer.selectedMentions.has("all")
									? "border-ink bg-ink text-page"
									: "border-line bg-page text-ink hover:border-ink hover:bg-hover",
							)}
						>
							<span>All</span>
							<span className="mono !text-[11px] opacity-80">@all</span>
						</button>

						{activeRoom.representative && activeRoom.members.some((m) => m.sessionId === activeRoom.representative) && (
							<button
								type="button"
								onClick={() => composer.onToggleMention(activeRoom.representative!)}
								data-imessage-notify-rep={activeRoom.representative}
								aria-pressed={
									composer.selectedMentions.has("all") || composer.selectedMentions.has(activeRoom.representative)
								}
								title="Notify the room's representative"
								className={cx(
									"inline-flex h-6 items-center gap-1 rounded-sm border px-2 font-medium",
									composer.selectedMentions.has("all") || composer.selectedMentions.has(activeRoom.representative)
										? "border-ink bg-ink text-page"
										: "border-line bg-page text-ink hover:border-ink hover:bg-hover",
								)}
							>
								Rep
							</button>
						)}

						{activeRoom.members.map((m) => {
							const active = composer.selectedMentions.has("all") || composer.selectedMentions.has(m.sessionId);
							const isRep = m.sessionId === activeRoom.representative;
							return (
								<button
									key={m.sessionId}
									type="button"
									onClick={() => composer.onToggleMention(m.sessionId)}
									data-imessage-mention={m.sessionId}
									data-imessage-notify-chip={m.sessionId}
									aria-pressed={active}
									title={[m.project, memberDevice(m)].filter(Boolean).join(" · ") || m.sessionId}
									className={cx(
										"inline-flex h-6 max-w-[22ch] items-center gap-1 rounded-sm border px-2 font-medium",
										active
											? "border-ink bg-ink text-page"
											: "border-line bg-page text-ink hover:border-ink hover:bg-hover",
									)}
								>
									<span className="truncate">{sessionLabel(m)}</span>
									{isRep && <RepBadge inverted={active} />}
								</button>
							);
						})}
					</div>
					<span className="ml-auto text-muted">{composer.mentionHint}</span>
				</div>
			)}

			<div className="relative">
				{composer.activeMentionMatch && composer.mentionCandidates.length > 0 && (
					<ul
						role="listbox"
						aria-label="Mention a room member"
						data-imessage-mention-menu=""
						className="menu-in absolute right-0 bottom-full left-0 z-20 mb-1 max-h-48 overflow-y-auto rounded-sm border border-ink bg-page py-1"
					>
						{composer.mentionCandidates.map((candidate, index) => {
							const active = index === composer.activeMentionIndex;
							return (
								<li key={`${candidate.token}-${index}`} role="option" aria-selected={active}>
									<button
										type="button"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => composer.onInsertMention(candidate)}
										data-imessage-mention-option={candidate.token}
										className={cx(
											"flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]",
											active ? "bg-ink text-page" : "text-ink hover:bg-hover",
										)}
									>
										<span className="mono shrink-0 !text-[12px] font-medium">@{candidate.token}</span>
										<span className="truncate">{candidate.label}</span>
										{candidate.representative && <RepBadge inverted={active} />}
										{candidate.detail && (
											<span className={cx("ml-auto shrink-0 truncate text-[11.5px]", active ? "text-page/75" : "text-muted")}>
												{candidate.detail}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				)}

				<div className="rounded-sm border border-line bg-page focus-within:border-ink">
					<label htmlFor={composerId} className="sr-only">
						Message
					</label>
					<textarea
						ref={composer.inputRef}
						id={composerId}
						rows={2}
						value={composer.text}
						onChange={(e) => {
							const val = e.target.value;
							composer.onTextChange(val, e.target.selectionStart ?? val.length);
						}}
						onSelect={(e) => composer.onCursorChange(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
						onKeyDown={composer.onKeyDown}
						placeholder={
							selection.kind === "room"
								? `Message #${selection.room} (type @ to mention)`
								: `Message ${activeDm?.label ?? "this session"}`
						}
						data-imessage-input=""
						className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-5 outline-none placeholder:text-muted"
					/>
					<div className="flex flex-wrap items-center gap-2 border-t border-line bg-soft/50 px-2.5 py-1.5">
						<button
							type="button"
							onClick={composer.onToggleUrgent}
							aria-pressed={composer.urgent}
							data-imessage-urgent=""
							title="Steer into a busy session's current turn instead of waiting for it to finish"
							className={cx(
								"inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-[12.5px] font-medium whitespace-nowrap",
								composer.urgent
									? "border-red bg-red-soft text-red"
									: "border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink",
							)}
						>
							<Icon name="alert" size={13} />
							Urgent
						</button>
						<span className="text-[12px] text-muted max-sm:hidden">
							<kbd className="mono !text-[11px]">Cmd/Ctrl+Enter</kbd> to send
						</span>
						<span
							data-imessage-bytes=""
							className={cx("tnum ml-auto text-[12px]", composer.tooLong ? "font-medium text-red" : "text-muted")}
						>
							{formatBytes(composer.bytes)} / 32 KB
						</span>
						<button
							type="button"
							onClick={() => void composer.onSend()}
							disabled={!composer.canSend}
							data-imessage-send=""
							className={cx(BUTTON.primary, "!h-7")}
						>
							{composer.sending ? "Sending…" : "Send"}
						</button>
					</div>
				</div>
			</div>

			{composer.tooLong && <p className="mt-1.5 text-[12px] text-red">The message is over the 32 KB limit. Shorten it to send.</p>}
			{composer.sendFeedback && (
				<p
					data-imessage-feedback={composer.sendFeedback.tone}
					role={composer.sendFeedback.tone === "error" ? "alert" : "status"}
					className={cx("mt-1.5 text-[12px]", composer.sendFeedback.tone === "error" ? "text-red" : "text-muted")}
				>
					{composer.sendFeedback.message}
				</p>
			)}
		</div>
	);
}
