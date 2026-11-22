import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMPECCABLE_TOOL_NAMES } from "../../src/activation.ts";
import { LIVE_SNAPSHOT, type LiveSaved } from "../../src/live.ts";
import { createImpeccableTestSession } from "./session.ts";

/** Actual AgentSession + resource loader, with in-memory credentials and only the faux provider. */
export async function liveSession(root: string, extra?: (pi: ExtensionAPI) => void, manager = SessionManager.inMemory(root), nativeTools = false, agentDir = root, activateImpeccableTools = true) {
	const defaultTools = activateImpeccableTools
		? [...(nativeTools ? ["read", "bash", "edit", "write"] : []), ...IMPECCABLE_TOOL_NAMES]
		: nativeTools ? undefined : [];
	const created = await createImpeccableTestSession({
		cwd: root,
		agentDir,
		api: "impeccable-live-test-api",
		provider: "impeccable-live-test",
		sessionManager: manager,
		afterImpeccable: extra,
		defaultTools,
	});
	const { session, faux, errors } = created;
	return {
		session, faux, errors, get api() { return created.api; },
		saved: () => {
			const entry = session.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === LIVE_SNAPSHOT);
			return entry?.type === "custom" ? entry.data as LiveSaved : undefined;
		},
		async cleanup() { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); },
	};
}
