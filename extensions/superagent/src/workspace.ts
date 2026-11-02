// The repository-wide workspace mode in `<git-common-dir>/superagent/workspace.json`; see DESIGN.md "Workspace modes".
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceMode, WorkspaceRecord } from "./types.ts";

export const WORKSPACE_FILE = "workspace.json";

/** The mode of a repository: its file, else the `workspace` setting. */
export interface WorkspaceSetting {
	mode(): WorkspaceMode;
	/** The recorded switch, if the file exists and is valid. */
	record(): WorkspaceRecord | undefined;
	/** Writes the file atomically (temp file + rename). */
	set(mode: WorkspaceMode, changedBy: string): WorkspaceRecord;
}

const isMode = (value: unknown): value is WorkspaceMode => value === "worktree" || value === "shared";

export function readWorkspaceRecord(root: string): WorkspaceRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(join(root, WORKSPACE_FILE), "utf8")) as Partial<WorkspaceRecord> | null;
		if (!value || !isMode(value.mode)) return undefined;
		return { mode: value.mode, changedAt: typeof value.changedAt === "number" ? value.changedAt : 0, changedBy: typeof value.changedBy === "string" ? value.changedBy : "" };
	} catch {
		return undefined;
	}
}

/** `root` is the store root, `<git-common-dir>/superagent/`; `fallback` the `workspace` setting, read at every call. */
export function openWorkspace(root: string, fallback: () => WorkspaceMode, now: () => number = Date.now): WorkspaceSetting {
	return {
		mode: () => readWorkspaceRecord(root)?.mode ?? fallback(),
		record: () => readWorkspaceRecord(root),
		set(mode, changedBy) {
			mkdirSync(root, { recursive: true });
			const record: WorkspaceRecord = { mode, changedAt: now(), changedBy };
			const path = join(root, WORKSPACE_FILE);
			const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			try {
				writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`);
				renameSync(temp, path);
			} catch (error) {
				try { unlinkSync(temp); } catch {}
				throw error;
			}
			return record;
		},
	};
}

/** In memory, for tests and callers without a store directory. */
export function memoryWorkspace(fallback: () => WorkspaceMode = () => "worktree"): WorkspaceSetting & { current?: WorkspaceRecord } {
	const setting: WorkspaceSetting & { current?: WorkspaceRecord } = {
		mode: () => setting.current?.mode ?? fallback(),
		record: () => setting.current,
		set(mode, changedBy) { setting.current = { mode, changedAt: Date.now(), changedBy }; return setting.current; },
	};
	return setting;
}
