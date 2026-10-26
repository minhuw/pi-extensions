import { randomUUID } from "node:crypto";
import type { RequestCompletion, RequestInput, Uploader } from "./uploader.ts";

interface ModelInfo { provider?: string; api?: string; model?: string }

/** One model call: the context pi built for it and, once spooled, its request id and what was spooled. */
interface Call {
	at: string;
	model: ModelInfo;
	messages?: unknown[];
	requestId?: string;
	seq?: number;
	spooled?: "payload" | "context";
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

const modelFields = (model: ModelInfo): ModelInfo => ({
	...(model.provider ? { provider: model.provider } : {}),
	...(model.api ? { api: model.api } : {}),
	...(model.model ? { model: model.model } : {}),
});

/**
 * Pairs model calls with their assistant messages for one session. A call starts at
 * `context_with_system`. `before_provider_request` spools its payload at once, held until the
 * next assistant `message_end` adds `assistant`, also an aborted or error one; a call that never
 * gets one (a compaction or other side request) is released without it. A call without a
 * payload is spooled with its context, held the same way, when its response starts; a payload
 * that still arrives for it replaces that record. A call that ends before either is dropped.
 */
export class SessionCapture {
	owner: object;
	private seq = 0;
	private call?: Call;

	constructor(readonly sessionId: string, readonly key: string, private readonly uploader: () => Uploader | undefined, owner: object) {
		this.owner = owner;
	}

	onContext(messages: unknown[], model: ModelInfo): void {
		this.settle();
		// Pi passes a fresh copy per call and nothing edits it after the last handler.
		this.call = { at: new Date().toISOString(), model, messages };
	}

	onPayload(payload: unknown, model: ModelInfo): void {
		const json = JSON.stringify(payload) ?? "null";
		if (!this.call || this.call.spooled === "payload") {
			this.settle();
			this.call = { at: new Date().toISOString(), model };
		}
		const call = this.call;
		call.requestId ??= randomUUID();
		call.spooled = "payload";
		void this.uploader()?.enqueueRequest(this.input(call, "payload", model), { json }, { awaiting: true });
	}

	/** The call's response started; without a payload by now, its context is spooled so a crash still records it. */
	onAssistantStart(message: AssistantLike): void {
		const call = this.call;
		if (!call?.messages || call.spooled) return;
		call.requestId = randomUUID();
		call.spooled = "context";
		const model = { provider: message.provider ?? call.model.provider, api: message.api ?? call.model.api, model: message.model ?? call.model.model };
		void this.uploader()?.enqueueRequest(this.input(call, "context", model), { value: { messages: call.messages } }, { awaiting: true });
	}

	onAssistant(message: AssistantLike): void {
		const call = this.call;
		if (!call) return;
		this.call = undefined;
		const model = { provider: message.provider ?? call.model.provider, api: message.api ?? call.model.api, model: message.model ?? call.model.model };
		const assistant = { timestamp: message.timestamp, ...(message.responseId ? { responseId: message.responseId } : {}) };
		if (call.requestId !== undefined) {
			const completion: RequestCompletion = { ...modelFields(model), assistant };
			void this.uploader()?.completeRequest(call.requestId, completion);
		} else if (call.messages) {
			void this.uploader()?.enqueueRequest({ ...this.input(call, "context", model), assistant }, { value: { messages: call.messages } });
		}
	}

	/** Releases an unanswered call's spooled request without `assistant`. */
	settle(): void {
		const call = this.call;
		this.call = undefined;
		if (call?.requestId !== undefined) void this.uploader()?.completeRequest(call.requestId);
	}

	private input(call: Call, fidelity: RequestInput["fidelity"], model: ModelInfo): RequestInput {
		return { id: call.requestId ?? randomUUID(), sessionId: this.sessionId, seq: call.seq ??= ++this.seq, at: call.at, fidelity, ...modelFields(model) };
	}
}
