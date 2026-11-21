import { formatDateTime } from "../../lib/format";
import { reasonMessage, shortReason } from "../../lib/relay";
import { cx, Pill } from "../ui";
import type { ChatMessage, PeerState } from "./types";

/** Busy is a filled, pulsing dot; idle an open ring; offline a faint dashed ring. */
export function StateDot({ state }: { state: PeerState }) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				"inline-block h-2 w-2 shrink-0 rounded-full",
				state === "busy" && "running-dot bg-current",
				state === "idle" && "border border-current",
				state === "offline" && "border border-dashed border-current opacity-55",
			)}
		/>
	);
}

/** Marks a room's representative; outlined in the text colour, or softened on inverted surfaces. */
export function RepBadge({ inverted = false }: { inverted?: boolean }) {
	return (
		<span
			title="Representative"
			data-imessage-representative=""
			className={cx(
				"inline-flex h-4 shrink-0 items-center rounded-sm border px-1 text-[11px] leading-none font-medium",
				inverted ? "border-page/60 text-page" : "border-current",
			)}
		>
			rep
		</span>
	);
}

export function DeliveryStatus({ message }: { message: ChatMessage }) {
	switch (message.status) {
		case "delivered":
			return (
				<span className="text-muted" title={message.deliveredAt ? `Delivered ${formatDateTime(message.deliveredAt)}` : undefined}>
					Delivered
				</span>
			);
		case "queued":
			return (
				<Pill tone="yellow" title="Waiting for the session to take it; dropped after 5 minutes">
					Queued
				</Pill>
			);
		case "expired":
			return <Pill title="Not delivered within 5 minutes, so it was dropped">Expired</Pill>;
		case "rejected":
			return (
				<Pill tone="red" title={reasonMessage(message.reason ?? "")}>
					Not delivered: {shortReason(message.reason)}
				</Pill>
			);
		default:
			return null;
	}
}
