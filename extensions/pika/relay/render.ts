import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { size } from "../log-viewer.ts";
import { headerField, MESSAGE_TYPE, NOTICE_TYPE, sanitize, type SentFrame, unmatchedOf } from "./protocol.ts";
import { type SideDetails, SIDE_TYPE } from "./side.ts";
import { type RelayMessageDetails, type RelayNoticeDetails, roomKey } from "./state.ts";
import { peerLabel, senderLabel } from "./viewer.ts";

export interface SendArgs { to?: string; room?: string; text?: string; urgent?: boolean; replyTo?: string }
export type ToolResult = { content: readonly { type: string; text?: string }[]; details?: unknown };

const resultText = (result: ToolResult) => sanitize(result.content.map((part) => part.type === "text" ? part.text ?? "" : "").join(""));
const firstLine = (text: string) => text.split("\n").find((line) => line.trim()) ?? "";

/**
 * `✉ relay → target [urgent] [reply to id] · size`, and the text when expanded. Every argument is the
 * model's, and a send it repeats may carry another device's text.
 */
export function sendCall(args: SendArgs, theme: Theme, expanded: boolean): Text {
	const room = roomKey(headerField(args.room));
	const target = room ? `#${room}` : headerField(args.to) || "?";
	const replyTo = headerField(args.replyTo);
	const text = sanitize(args.text);
	const tags = [args.urgent ? theme.fg("warning", "urgent") : "", replyTo ? theme.fg("dim", `reply to ${replyTo}`) : ""].filter(Boolean);
	const head = `${theme.fg("accent", "✉ relay →")} ${theme.bold(target)}${tags.length ? ` ${tags.join(" ")}` : ""} ${theme.fg("dim", `· ${size(text)}`)}`;
	return new Text([head, ...(expanded ? text.split("\n").map((line) => `  ${line}`) : [])].join("\n"), 0, 0);
}

/** The whole result when expanded; else one line: an error's first line, or what became of the message. */
export function resultLine(result: ToolResult, expanded: boolean, isError: boolean, theme: Theme, summary: () => string | undefined): Text {
	const text = resultText(result);
	if (isError) return new Text(theme.fg("error", expanded ? text : firstLine(text)), 0, 0);
	return new Text(expanded ? text : summary() ?? firstLine(text), 0, 0);
}

export function sentSummary(frame: Partial<Extract<SentFrame, { id: string }>> | undefined, theme: Theme): string | undefined {
	if (!frame?.id || (frame.status !== "delivered" && frame.status !== "queued")) return undefined;
	const id = theme.fg("dim", `· ${headerField(frame.id)}`);
	if (frame.room) {
		const notified = (frame.notified ?? []).map((target) => headerField(target.name) || headerField(target.title) || headerField(target.sessionId));
		const unmatched = unmatchedOf(frame);
		return `${theme.fg("success", `posted to #${headerField(frame.room)}`)} · ${notified.length ? `notified ${notified.join(", ")}` : "no one notified"}`
			+ `${unmatched.length ? ` · ${theme.fg("warning", `not members: ${unmatched.join(", ")}`)}` : ""} ${id}`;
	}
	return frame.status === "delivered"
		? `${theme.fg("success", "delivered")} to ${peerLabel(frame.to)} ${id}`
		: `${theme.fg("warning", "queued")} for ${peerLabel(frame.to)}, not delivered yet ${id}`;
}

/** Registers the custom message renderers for received relay messages, side answers, and delivery notices. */
export function registerRenderers(pi: ExtensionAPI): void {
	// Every field of a message comes from another device: no terminal sequences reach the TUI. The model
	// reads the message; the transcript shows one line, and the text when expanded or in /relay log.
	pi.registerMessageRenderer<RelayMessageDetails>(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details?.from) return undefined;
		const roomTag = details.room ? theme.fg("accent", `#${headerField(details.room)}`) : "";
		const replyTo = headerField(details.replyTo);
		const tags = [roomTag, details.urgent ? theme.fg("warning", "urgent") : "", replyTo ? theme.fg("dim", `reply to ${replyTo}`) : ""].filter(Boolean);
		const text = sanitize(details.text);
		return new Text([
			`${theme.fg("accent", "✉ relay ←")} ${theme.bold(senderLabel(details.from))}${tags.length ? ` ${tags.join(" ")}` : ""} ${theme.fg("dim", `· ${size(text)}`)}`,
			...(expanded ? text.split("\n").map((line) => `  ${line}`) : []),
		].join("\n"), 0, 0);
	});

	pi.registerMessageRenderer<SideDetails>(SIDE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const text = sanitize(details.text);
		return new Text([
			`${theme.fg("accent", "✉ relay side answer →")} ${theme.bold(headerField(details.label))} ${theme.fg("dim", `· ${size(text)}`)}`,
			...(expanded ? text.split("\n").map((line) => `  ${line}`) : []),
		].join("\n"), 0, 0);
	});

	pi.registerMessageRenderer<RelayNoticeDetails>(NOTICE_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		// The first line is the notice; what follows it is only for the model.
		return new Text(`${theme.fg("warning", "✉ relay")} ${sanitize(content).replace(/^\[relay\] /, "").split("\n", 1)[0]}`, 0, 0);
	});
}
