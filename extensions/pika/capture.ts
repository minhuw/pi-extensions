import { randomUUID } from "node:crypto";
import type { RequestTiming } from "./store.ts";
import type { RequestCompletion, RequestInput, Uploader } from "./uploader.ts";

interface ModelInfo { provider?: string; api?: string; model?: string }

/** One model call: the context pi built for it, once spooled its request id and what was spooled, and the times known so far. */
interface Call {
	at: string;
	model: ModelInfo;
	messages?: unknown[];
	requestId?: string;
	seq?: number;
	spooled?: "payload" | "context";
	timing?: RequestTiming;
}

/** The kind of first token an assistant stream event carries, if it carries one. */
function tokenKind(type: string): RequestTiming["firstToken"] {
	switch (type) {
		case "text_delta": return "text";
		case "thinking_delta": return "thinking";
		case "toolcall_delta": return "toolCall";
		default: return undefined;
	}
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
 * The call also notes when its payload was sent (`before_provider_request`), when the provider
 * answered (`after_provider_response`), and when its first text, thinking, or tool-call token
 * arrived (`message_update`); `message_end` adds them as `timing`.
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
		(call.timing ??= {}).sentAt = Date.now();
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

	/** The provider answered the call's request; a transport that retries keeps the first answer. */
	onResponse(): void {
		const call = this.call;
		if (call && call.timing?.responseAt === undefined) (call.timing ??= {}).responseAt = Date.now();
	}

	/** Records the call's first token. It runs for every streamed token, so it allocates nothing once that is known. */
	onUpdate(message: unknown, type: string): void {
		const call = this.call;
		if (!call || call.timing?.firstToken !== undefined) return;
		const kind = tokenKind(type);
		if (!kind || !isAssistant(message)) return;
		const timing = call.timing ??= {};
		timing.firstTokenAt = Date.now();
		timing.firstToken = kind;
	}

	onAssistant(message: AssistantLike): void {
		const call = this.call;
		if (!call) return;
		this.call = undefined;
		const model = { provider: message.provider ?? call.model.provider, api: message.api ?? call.model.api, model: message.model ?? call.model.model };
		const assistant = { timestamp: message.timestamp, ...(message.responseId ? { responseId: message.responseId } : {}) };
		const timing = call.timing ? { timing: call.timing } : {};
		if (call.requestId !== undefined) {
			const completion: RequestCompletion = { ...modelFields(model), assistant, ...timing };
			void this.uploader()?.completeRequest(call.requestId, completion);
		} else if (call.messages) {
			void this.uploader()?.enqueueRequest({ ...this.input(call, "context", model), assistant, ...timing }, { value: { messages: call.messages } });
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
