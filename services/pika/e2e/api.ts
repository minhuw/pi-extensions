/** A client for pika's read API that signs in with the password, as the web UI does. */
export class ReadApi {
	readonly base: string;
	private readonly password: string;
	private cookie = "";

	constructor(base: string, password: string) {
		this.base = base;
		this.password = password;
	}

	async login(): Promise<void> {
		const response = await fetch(`${this.base}/api/v1/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: this.password }),
		});
		if (response.status !== 200) throw new Error(`login answered ${response.status}`);
		const set = response.headers.get("set-cookie") ?? "";
		this.cookie = set.split(";")[0] ?? "";
		if (!this.cookie) throw new Error("login set no cookie");
	}

	async raw(path: string): Promise<Response> {
		return fetch(`${this.base}/api/v1/${path}`, { headers: { cookie: this.cookie } });
	}

	/** The JSON body, or undefined for 404. */
	async get<T>(path: string): Promise<T | undefined> {
		const response = await this.raw(path);
		if (response.status === 404) return undefined;
		if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
		return await response.json() as T;
	}

	/** POSTs a JSON body; returns the status and the parsed JSON answer. */
	async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
		const response = await fetch(`${this.base}/api/v1/${path}`, {
			method: "POST", headers: { cookie: this.cookie, "content-type": "application/json" }, body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() as T };
	}

	async text(path: string): Promise<string | undefined> {
		const response = await this.raw(path);
		if (response.status === 404) return undefined;
		if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}`);
		return Buffer.from(await response.arrayBuffer()).toString("utf8");
	}
}

export interface Entry {
	seq: number;
	offset: number;
	id?: string;
	type: string;
	raw: Record<string, unknown>;
	requestId?: string;
	truncated?: boolean;
}

export interface SessionSummary {
	id: string;
	device: string;
	project: string;
	title: string;
	entryCount: number;
	parentSessionId?: string;
	link?: { kind?: string; parentToolCallId?: string; agentType?: string; herder?: { runId?: string; stepKey?: string } };
	childCount: number;
	herderRunId?: string;
}

export interface SessionDetail extends SessionSummary {
	children: (SessionSummary & { parentToolCallId?: string })[];
}

export interface Turn {
	index: number;
	startSeq: number;
	endSeq: number;
	userText: string;
	modelCalls: number;
	toolCalls: number;
	finalText: string;
}

export interface ModelRequest {
	id: string;
	sessionId: string;
	fidelity: string;
	complete: boolean;
	payload: unknown;
}

export interface RunDetail {
	run: { runId: string; device: string; repo: string; title: string; status: string; stepCount: number };
	goal?: string;
	plan?: string;
	events: { seq: number; t: string }[];
	steps: { key: string; id: string; role: string; status: string; sessionId?: string }[];
}

/** Every entry of a session, paged by seq. */
export async function allEntries(api: ReadApi, sessionId: string): Promise<Entry[] | undefined> {
	const out: Entry[] = [];
	for (let from = 0; ;) {
		const page = await api.get<{ items: Entry[] }>(`sessions/${encodeURIComponent(sessionId)}/entries?from=${from}&limit=1000`);
		if (!page) return out.length ? out : undefined;
		out.push(...page.items);
		if (page.items.length < 1000) return out;
		from = page.items[page.items.length - 1]!.seq + 1;
	}
}
