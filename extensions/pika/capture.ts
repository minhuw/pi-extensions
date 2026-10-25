import { randomUUID } from "node:crypto";
import type { PayloadSource, RequestInput, Uploader } from "./uploader.ts";

interface ModelInfo { provider?: string; api?: string; model?: string }

/** One model call: the context pi built for it and, when the provider exposes it, the payload. */
interface Call {
	at: string;
	model: ModelInfo;
	messages?: unknown[];
	payload?: string;
}

interface AssistantLike {
	role: "assistant";
	timestamp: number;
	responseId?: string;
	provider?: string;
	api?: string;
	model?: string;
}

export function isAssistant(message: unknown): message is AssistantLike {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant"
		&& typeof (message as { timestamp?: unknown }).timestamp === "number";
}

/**
 * Pairs model calls with their assistant messages for one session. A call starts at
 * `context_with_system`; `before_provider_request` attaches the payload, and the next
 * assistant `message_end` completes it. A call that never gets an assistant message (an
 * abort before the response, a compaction or other side request) is recorded without
 * `assistant` when it carries a payload, and dropped when it only has context.
 */
export class SessionCapture {
	owner: object;
	private seq = 0;
	private call?: Call;

	constructor(readonly sessionId: string, readonly key: string, private readonly uploader: Uploader, owner: object) {
		this.owner = owner;
	}

	onContext(messages: unknown[], model: ModelInfo): void {
		this.settle();
		// Pi passes a fresh copy per call and nothing edits it after the last handler.
		this.call = { at: new Date().toISOString(), model, messages };
	}

	onPayload(payload: unknown, model: ModelInfo): void {
		const json = JSON.stringify(payload) ?? "null";
		if (this.call && this.call.payload === undefined) { this.call.payload = json; return; }
		this.settle();
		this.call = { at: new Date().toISOString(), model, payload: json };
	}

	onAssistant(message: AssistantLike): void {
		const call = this.call;
		if (!call) return;
		this.call = undefined;
		this.record(call, message);
	}

	/** Records an unanswered call that has a payload. */
	settle(): void {
		const call = this.call;
		this.call = undefined;
		if (call?.payload !== undefined) this.record(call);
	}

	private record(call: Call, assistant?: AssistantLike): void {
		let source: PayloadSource;
		let fidelity: RequestInput["fidelity"];
		if (call.payload !== undefined) { source = { json: call.payload }; fidelity = "payload"; }
		else if (assistant && call.messages) { source = { value: { messages: call.messages } }; fidelity = "context"; }
		else return;
		const model: ModelInfo = assistant
			? { provider: assistant.provider ?? call.model.provider, api: assistant.api ?? call.model.api, model: assistant.model ?? call.model.model }
			: call.model;
		const input: RequestInput = {
			id: randomUUID(), sessionId: this.sessionId, seq: ++this.seq, at: call.at, fidelity,
			...(model.provider ? { provider: model.provider } : {}),
			...(model.api ? { api: model.api } : {}),
			...(model.model ? { model: model.model } : {}),
			...(assistant ? { assistant: { timestamp: assistant.timestamp, ...(assistant.responseId ? { responseId: assistant.responseId } : {}) } } : {}),
		};
		void this.uploader.enqueueRequest(input, source);
	}
}
