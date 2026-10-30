import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runEngine, sha256, truncateText } from "./engine.ts";
import { hookStatus, object, optionalText, readConfigs, resolveEditPath, resolveProject, serialized, withGitExcludeMutation } from "./project.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SCANS = 24;
const MAX_FILES = 20;
const MAX_FEEDBACK_BYTES = 12_000;
const UI_EXTENSIONS = [".tsx", ".jsx", ".html", ".htm", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".ts", ".js"];

/** T5 seam: these are the upstream hook's exact temporary preview markers. */
export function hasLivePreviewMarkers(content: string): boolean {
	return content.includes("data-impeccable-variants=") || content.includes("impeccable-carbonize-start");
}
export interface DetectorFeedback {
	phase: "immediate" | "completion";
	root: string;
	status: string;
	text: string;
	audit?: Record<string, unknown>;
	attribution: "upstream-conservative";
}
interface BeforeEdit { file: string; root: string; before: string | null | undefined; input: Record<string, unknown>; generation: number }
interface RootState { directory: string; files: Map<string, string>; completion?: string; generation?: number }

async function boundedSource(file: string): Promise<string | null | undefined> {
	try { if ((await stat(file)).size > MAX_SOURCE_BYTES) return undefined; return await readFile(file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return undefined; }
}

function expectedContent(edit: BeforeEdit): string | undefined {
	if (typeof edit.input.content === "string") return edit.input.content;
	if (typeof edit.before !== "string") return undefined;
	let text = edit.before;
	const edits = Array.isArray(edit.input.edits) ? edit.input.edits : [edit.input];
	for (const item of edits) {
		if (!object(item)) return undefined;
		const old = item.oldText ?? item.oldString; const replacement = item.newText ?? item.newString;
		if (typeof old !== "string" || typeof replacement !== "string" || !old || text.split(old).length !== 2) return undefined;
		text = text.replace(old, () => replacement);
	}
	return text;
}

export function registerDetector(pi: ExtensionAPI): () => Promise<void> {
	if (typeof pi.on !== "function") return async () => {};
	let generation = 0;
	let controller = new AbortController();
	let sessionId = randomUUID();
	let scans = 0;
	let continuations = 0;
	let captures = 0;
	let stopped = false;
	let feedback: DetectorFeedback[] = [];
	const seen = new Map<string, string>();
	const pending = new Map<string, BeforeEdit>();
	const roots = new Map<string, RootState>();
	const directories = new Set<string>();
	const workRoots = new Set<string>();

	const invalidate = () => { generation++; controller.abort(); controller = new AbortController(); pending.clear(); feedback = []; };
	async function cleanup() {
		stopped = true; invalidate();
		await Promise.all([...new Set([...roots.keys(), ...workRoots])].map((root) => serialized(root, async () => {})));
		await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
		directories.clear(); roots.clear(); seen.clear(); workRoots.clear();
	}
	pi.on("session_start", () => { stopped = false; });
	pi.on("session_shutdown", cleanup);
	pi.on("session_tree", async () => { await cleanup(); stopped = false; sessionId = randomUUID(); });
	pi.on("input", () => { invalidate(); seen.clear(); });
	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") { scans = 0; continuations = 0; }
	});

	const add = (entry: DetectorFeedback) => {
		const key = sha256(Buffer.from(`${entry.root}\0${entry.status}\0${entry.text}`));
		if (seen.has(key) || feedback.length >= 8) return;
		seen.set(key, entry.root); if (seen.size > 128) seen.delete(seen.keys().next().value!);
		feedback.push(entry);
	};

	async function stateFor(root: string): Promise<RootState> {
		let state = roots.get(root);
		if (!state) {
			const directory = await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-hook-"));
			directories.add(directory);
			state = { directory, files: new Map() }; roots.set(root, state);
		}
		return state;
	}

	async function executeScan(root: string, phase: DetectorFeedback["phase"], event: Record<string, unknown>, ctx: ExtensionContext, revision: number) {
		if (stopped || revision !== generation || ctx.signal?.aborted) return;
		if (scans >= MAX_SCANS) { add({ phase, root, status: "truncated", text: "Automatic scan budget reached; narrow a manual detect run for remaining work.", attribution: "upstream-conservative" }); return; }
		scans++;
		const ownerSignal = controller.signal;
		const status = await hookStatus(root);
		if (!status.enabled) return;
		const state = await stateFor(root);
		if (stopped || revision !== generation || ctx.signal?.aborted) return;
		const auditFile = path.join(state.directory, "audit.ndjson");
		await rm(auditFile, { force: true });
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, ownerSignal]) : ownerSignal;
		// persist_cache maintains Git exclusions in the child. Hold that file's
		// complete transaction through child exit, including first scans in other
		// workspaces/processes and Pi native exclusion edits.
		const result = await withGitExcludeMutation(root, signal, () => runEngine({ argv: ["hook"], cwd: root, timeoutMs: 10_000,
			stdin: JSON.stringify({ ...event, cwd: root, session_id: sessionId }),
			signal,
			env: { IMPECCABLE_HOOK_HARNESS: "claude", IMPECCABLE_CACHE_ROOT: path.join(state.directory, "cache"), IMPECCABLE_HOOK_SESSION_DIR: path.join(state.directory, "sessions"), IMPECCABLE_HOOK_CLAIM_DIR: path.join(state.directory, "claims"), IMPECCABLE_HOOK_LOG: auditFile },
		}));
		if (stopped || revision !== generation || ctx.signal?.aborted) return;
		if (!result.ok) { add({ phase, root, status: result.status, text: [result.message, result.stderr].filter(Boolean).join("\n") || `Automatic hook ${result.status}; no complete result established.`, attribution: "upstream-conservative" }); return; }
		let audit: Record<string, unknown> | undefined;
		try {
			const auditSize = await stat(auditFile).then((info) => info.size).catch(() => 0);
			if (auditSize > MAX_FEEDBACK_BYTES) add({ phase, root, status: "truncated", text: "Hook audit exceeded the capture bound; completeness is unknown.", attribution: "upstream-conservative" });
			const raw = auditSize <= MAX_FEEDBACK_BYTES ? await optionalText(auditFile) : undefined;
			if (raw && Buffer.byteLength(raw) <= MAX_FEEDBACK_BYTES) {
				const parsed: unknown = JSON.parse(raw.trim()); if (object(parsed)) audit = parsed;
				const log = process.env.IMPECCABLE_HOOK_LOG || status.hook.auditLog;
				if (typeof log === "string" && log) {
					const destination = path.resolve(root, log.startsWith("~/") ? path.join(os.homedir(), log.slice(2)) : log);
					await mkdir(path.dirname(destination), { recursive: true }); await appendFile(destination, raw);
				}
			}
		} catch (error) { add({ phase, root, status: "error", text: `Hook audit/log unavailable: ${String(error)}`, attribution: "upstream-conservative" }); }
		if (audit?.error) { add({ phase, root, status: "error", text: `Upstream hook error: ${String(audit.error)}; detector coverage is unavailable.`, audit, attribution: "upstream-conservative" }); return; }
		// Zero fresh findings alone can mean deduplication. Only an upstream clean
		// acknowledgement/zero findings retires feedback so resolved debt can recur.
		if (audit?.kind === "clean" || audit?.findings === 0) {
			for (const [key, owner] of seen) if (owner === root) seen.delete(key);
		}
		if (audit?.skipped === "native-platform") { add({ phase, root, status: "inapplicable", text: `Web detector inapplicable to ${String(audit.platform)}; no clean scan established.`, audit, attribution: "upstream-conservative" }); return; }
		if (!result.stdout.trim()) {
			// Silence is not proof of a clean scan (ignores, previews and limits also skip).
			if (audit?.skipped && !["live-preview", "no-touched-files", "no-fresh-findings", "duplicate-event"].includes(String(audit.skipped))) add({ phase, root, status: "skipped", text: `Upstream hook skipped: ${String(audit.skipped)}`, audit, attribution: "upstream-conservative" });
			if (!audit) add({ phase, root, status: "unavailable", text: "Hook returned no feedback or audit record; scan completeness is unknown.", attribution: "upstream-conservative" });
			return;
		}
		try {
			const payload: unknown = JSON.parse(result.stdout);
			if (!object(payload) || !object(payload.hookSpecificOutput) || typeof payload.hookSpecificOutput.additionalContext !== "string") throw new Error("unsupported upstream hook payload");
			const text = truncateText(payload.hookSpecificOutput.additionalContext, MAX_FEEDBACK_BYTES, 160);
			add({ phase, root, status: text.truncated ? "truncated" : audit?.freshFindings ? "findings" : "feedback", text: text.text + (text.truncated ? "\nFeedback truncated; use a narrower manual detect run." : ""), audit, attribution: "upstream-conservative" });
		} catch (error) { add({ phase, root, status: "error", text: `Invalid hook JSON: ${String(error)}`, audit, attribution: "upstream-conservative" }); }
	}

	async function scan(root: string, phase: DetectorFeedback["phase"], event: Record<string, unknown>, ctx: ExtensionContext, revision: number) {
		try { await executeScan(root, phase, event, ctx, revision); }
		catch (error) { if (!stopped && revision === generation && !ctx.signal?.aborted) add({ phase, root, status: "error", text: `Automatic detector failed: ${String(error)}`, attribution: "upstream-conservative" }); }
	}

	pi.on("tool_call", async (event, ctx) => {
		if (stopped || !["write", "edit"].includes(event.toolName) || pending.size + captures >= 64) return;
		const input = event.input as Record<string, unknown>;
		const supplied = input.path ?? input.file_path;
		if (typeof supplied !== "string") return;
		const revision = generation;
		const file = resolveEditPath(supplied, ctx.cwd);
		captures++;
		try {
			const root = await resolveProject(ctx.cwd, file, { sourcePath: true });
			const status = await hookStatus(root);
			if (!status.enabled || revision !== generation) return;
			if (roots.size >= 4 && !roots.has(root)) { add({ phase: "immediate", root, status: "truncated", text: "Automatic project limit reached; scan this target manually.", attribution: "upstream-conservative" }); return; }
			const configs = await readConfigs(root);
			const extra = configs.flatMap((config) => [config.value.hook, config.value.detector].flatMap((section) => object(section) && Array.isArray(section.extensions) ? section.extensions.flatMap((item) => {
				// Match upstream normalize_extension_entries for eligibility only;
				// the hook still owns engine selection and detector rules.
				const raw = typeof item === "string" ? item : object(item) ? item.ext : undefined;
				if (typeof raw !== "string" || !raw.trim()) return [];
				const extension = raw.trim().toLowerCase();
				return [extension.startsWith(".") ? extension : `.${extension}`];
			}) : []));
			if (![...UI_EXTENSIONS, ...extra].some((extension) => file.toLowerCase().endsWith(extension.toLowerCase()))) return;
			const before = await boundedSource(file);
			if (revision === generation) pending.set(event.toolCallId, { file, root, before, input: structuredClone(input), generation: revision });
		} catch (error) { add({ phase: "immediate", root: ctx.cwd, status: "error", text: String(error), attribution: "upstream-conservative" }); }
		finally { captures--; }
	});
	pi.on("tool_result", async (event, ctx) => {
		const edit = pending.get(event.toolCallId); pending.delete(event.toolCallId);
		if (!edit || event.isError || stopped || edit.generation !== generation || ctx.signal?.aborted) return;
		workRoots.add(edit.root);
		try { await serialized(edit.root, async () => {
			const current = await boundedSource(edit.file);
			if (stopped || edit.generation !== generation || ctx.signal?.aborted) return;
			if (roots.size >= 4 && !roots.has(edit.root)) { add({ phase: "immediate", root: edit.root, status: "truncated", text: "Automatic project limit reached; scan this target manually.", attribution: "upstream-conservative" }); return; }
			if (current === undefined) { add({ phase: "immediate", root: edit.root, status: "unavailable", text: "Edited source unavailable or exceeds the 512 KiB capture bound; no complete scan established.", attribution: "upstream-conservative" }); return; }
			if (typeof current !== "string" || current === edit.before || hasLivePreviewMarkers(current)) return;
			const state = await stateFor(edit.root);
			const hash = sha256(Buffer.from(current));
			if (state.files.get(edit.file) === hash) return;
			if (state.files.size >= MAX_FILES && !state.files.has(edit.file)) { add({ phase: "immediate", root: edit.root, status: "truncated", text: "Automatic primary-file limit reached; scan remaining targets manually.", attribution: "upstream-conservative" }); return; }
			state.files.set(edit.file, hash);
			const verified = edit.before !== undefined && expectedContent(edit) === current;
			await scan(edit.root, "immediate", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: edit.file }, tool_response: { filePath: edit.file, originalFile: verified ? edit.before : undefined, content: current, type: edit.before === null ? "create" : "update", userModified: !verified } }, ctx, edit.generation);
			if (!stopped && edit.generation === generation && !ctx.signal?.aborted) state.generation = generation;
		}); } catch (error) {
			if (!stopped && edit.generation === generation && !ctx.signal?.aborted) add({ phase: "immediate", root: edit.root, status: "unavailable", text: `Detector state unavailable: ${String(error)}`, attribution: "upstream-conservative" });
		}
		// Feedback is a boundary entry, so structured tool output is never rewritten.
	});

	function entries(): SessionBoundaryDraft[] {
		const items = feedback; feedback = [];
		if (!items.length) return [];
		const text = truncateText(items.map((item) => `[Impeccable ${item.phase}; ${item.status}; ${item.root}]\n${item.text}`).join("\n\n"), MAX_FEEDBACK_BYTES, 200);
		return [{ type: "custom_message", customType: "impeccable-detector", content: text.text + (text.truncated ? "\nFeedback truncated." : ""), display: true, details: { feedback: items, maxCorrectiveContinuations: 1 } }];
	}
	pi.on("turn_end", async (event, ctx) => {
		if (stopped || ctx.signal?.aborted || ctx.hasPendingMessages() || event.message.role === "assistant" && event.message.stopReason === "aborted") { feedback = []; return; }
		if (!event.context && typeof pi.sendMessage === "function") {
			// Pi peers predating actionable boundaries can receive immediate context,
			// but cannot safely request a completion pass or automatic continuation.
			const drafts = entries();
			for (const draft of drafts) if (draft.type === "custom_message") pi.sendMessage({ customType: draft.customType, display: draft.display, content: `${String(draft.content)}\nCompletion deep pass and automatic correction are unavailable on this Pi version; run manual detect after the edits.`, details: draft.details }, { triggerTurn: false });
			return;
		}
		if (event.outcome !== "completed") { feedback = []; return; }
		// Pi clears agent.signal before agent_before_settle. Do all subprocess work
		// on the terminal turn while its abort signal still owns this boundary.
		const appendEntries = () => {
			const drafts = entries();
			return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
		};
		const terminal = event.message.role === "assistant" && !event.message.content.some((item) => item.type === "toolCall");
		if (!terminal || event.continue) return appendEntries();
		const signal = ctx.signal;
		if (!signal) {
			if ([...roots.values()].some((state) => state.generation === generation && state.files.size && state.completion !== JSON.stringify([...state.files]))) add({ phase: "completion", root: ctx.cwd, status: "unavailable", text: "Completion deep pass requires an abort-aware Pi turn boundary; run manual detect.", attribution: "upstream-conservative" });
			return appendEntries();
		}
		const revision = generation;
		for (const [root, state] of roots) {
			if (stopped || revision !== generation || signal.aborted || ctx.hasPendingMessages()) break;
			const signature = JSON.stringify([...state.files]);
			if (state.generation !== generation || !state.files.size || state.completion === signature) continue;
			await serialized(root, () => scan(root, "completion", { hook_event_name: "Stop", stop_hook_active: false }, ctx, revision));
			if (!stopped && revision === generation && !signal.aborted && !ctx.hasPendingMessages()) state.completion = signature;
		}
		if (stopped || revision !== generation || signal.aborted || ctx.hasPendingMessages()) { feedback = []; return; }
		const findings = feedback.some((item) => item.status === "findings");
		const result = appendEntries();
		// A custom message supplies runnable context for at most one correction.
		if (findings && result && continuations < 1 && !event.continue) { continuations++; return { ...result, continue: true }; }
		return result;
	});
	return async () => { await cleanup(); stopped = false; sessionId = randomUUID(); };
}
