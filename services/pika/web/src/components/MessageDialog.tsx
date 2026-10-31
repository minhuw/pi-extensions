import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ApiError, useApi } from "../lib/api";
import { deviceLabel } from "../lib/devices";
import { MAX_TEXT_BYTES, reasonMessage, RELAY_EVENTS_KEY, sessionLabel, targetLabel, utf8Length } from "../lib/relay";
import type { OnlineSession } from "../lib/types";
import { Icon } from "./icons";
import { BUTTON, Callout, cx, Dialog } from "./ui";

type Result = { status: "delivered" | "queued" | "rejected"; text: string };

/** Ctrl+Enter, or Cmd+Enter on a Mac. */
function isSendKey(event: ReactKeyboardEvent): boolean {
	return event.key === "Enter" && (event.ctrlKey || event.metaKey);
}

/**
 * A modal composer for a message from the user to an online session. It stays open after sending, showing the
 * outcome and ready for another message; on a refusal the text stays. Escape and the backdrop close it while nothing
 * is typed, so typed text is never lost to a stray key. Escape stops at the dialog: the page underneath (a context
 * drawer, shortcuts) doesn't see it.
 */
export function MessageDialog({ session, onClose }: { session: OnlineSession; onClose: () => void }) {
	const api = useApi();
	const queryClient = useQueryClient();
	const textId = useId();
	const [text, setText] = useState("");
	const [urgent, setUrgent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<Result | null>(null);
	const textRef = useRef<HTMLTextAreaElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	const busyRef = useRef(busy);
	busyRef.current = busy;
	const textValue = useRef(text);
	textValue.current = text;
	// Set as soon as a send starts, before React re-renders with `busy`, so a second Ctrl+Enter can't send twice.
	const sending = useRef(false);

	useEffect(() => {
		// Focus returns to the button that opened the dialog.
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		textRef.current?.focus();
		// In the capture phase, so it runs before the page's own Escape handlers and can stop them.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Nothing below the composer, the dialog frame's own Escape included, sees it.
			event.stopPropagation();
			// Escape while composing with an input method cancels the composition, not the dialog.
			if (event.isComposing) return;
			event.preventDefault();
			if (!busyRef.current && textValue.current === "") close.current();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			if (opener?.isConnected) opener.focus();
		};
	}, []);

	const label = sessionLabel(session);
	const bytes = utf8Length(text);
	const tooLong = bytes > MAX_TEXT_BYTES;
	const canSend = text.trim() !== "" && !tooLong && !busy;

	const send = async () => {
		if (!canSend || sending.current) return;
		sending.current = true;
		setBusy(true);
		// The previous result stays, dimmed, until this one replaces it, so nothing moves under the pointer.
		try {
			const sent = await api.sendRelayMessage({ to: session.id, text, urgent });
			const to = targetLabel({ device: session.device, deviceName: session.deviceName, name: session.name, title: session.title, ...sent.to, sessionId: session.id });
			setResult(
				sent.status === "delivered"
					? { status: "delivered", text: `Delivered to ${to}.` }
					: {
							status: "queued",
							text: `Queued for ${to}: it has not been delivered yet. If it is not delivered within 5 minutes it is dropped.`,
						},
			);
			setText("");
			setUrgent(false);
		} catch (cause) {
			// 400 and 429 carry a rejection reason, and 404 says relay is off; anything else is a plain error.
			const refused = cause instanceof ApiError && [400, 404, 429].includes(cause.status);
			setResult({ status: "rejected", text: refused ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause) });
		} finally {
			sending.current = false;
			setBusy(false);
			void queryClient.invalidateQueries({ queryKey: RELAY_EVENTS_KEY });
			textRef.current?.focus();
		}
	};

	return (
		<Dialog
			title={`Message ${label}`}
			onCancel={() => {
				// The backdrop closes only an empty composer; Escape is handled above, in the capture phase, and stops there.
				if (textValue.current === "" && !busyRef.current) close.current();
			}}
		>
			<div data-message-dialog={session.id}>
				<div className="mt-0.5 flex min-w-0 flex-wrap gap-x-3 text-[13px] text-muted">
					<span className="flex items-center gap-1">
						<Icon name="device" size={13} />
						{deviceLabel(session)}
					</span>
					{session.project && (
						<span className="flex items-center gap-1">
							<Icon name="folder" size={13} />
							{session.project}
						</span>
					)}
					<span className="mono !text-[12px] break-all">{session.id}</span>
				</div>
				<label htmlFor={textId} className="sr-only">
					Message text
				</label>
				<textarea
					id={textId}
					ref={textRef}
					value={text}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (!isSendKey(event)) return;
						event.preventDefault();
						void send();
					}}
					rows={5}
					placeholder="Write a message. The session gets it as a new turn, marked as coming from you in the web UI."
					aria-invalid={tooLong}
					className="mt-3 block w-full resize-y rounded-sm border border-line bg-page px-2.5 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted focus-visible:border-ink"
				/>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<label className="flex items-center gap-2 text-[14px]">
						<input type="checkbox" className="accent-ink" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} />
						Urgent
						<span className="text-[13px] text-muted">(interrupts a busy session)</span>
					</label>
					<span className="ml-auto text-[12px] text-muted">
						<kbd className="mono !text-[12px]">⌘/Ctrl+Enter</kbd> to send
					</span>
					<button type="button" onClick={onClose} disabled={busy} className={BUTTON.secondary}>
						Close
					</button>
					<button type="button" onClick={() => void send()} disabled={!canSend} className={BUTTON.primary}>
						{busy ? "Sending…" : "Send"}
					</button>
				</div>
				{/* Below the buttons, so neither appearing nor changing moves them. */}
				{tooLong && <div className="mt-2 text-[13px] text-red">The message is too long: the limit is 32 KiB.</div>}
				{result && (
					<div
						className={cx("mt-3 transition-opacity", busy && "opacity-50")}
						role={result.status === "rejected" ? undefined : "status"}
						aria-busy={busy || undefined}
						data-send-result={result.status}
					>
						<Callout tone={result.status === "delivered" ? "green" : result.status === "queued" ? "yellow" : "red"} title={result.status === "rejected" ? "Not sent" : undefined}>
							<div className="text-[14px]">{result.text}</div>
						</Callout>
					</div>
				)}
			</div>
		</Dialog>
	);
}
