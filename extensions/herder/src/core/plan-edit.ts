import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { planIndexReworkLayout } from "./plans.ts";
import type { PlanTransientRef } from "../daemon/git-driver.ts";
import type { RunStore, StoredPlanEdit, StoredRun } from "../daemon/run-store.ts";
import { sha256, stableJson } from "../shared/protocol.ts";

export function graphInputSha256(planDirectory: string): string {
	const files = planGraphFiles(planDirectory);
	const hash = createHash("sha256");
	for (const name of files) {
		hash.update(name);
		hash.update("\0");
		hash.update(fs.readFileSync(path.join(planDirectory, name)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export interface ReworkGraphSnapshot {
	schemaVersion: 1;
	runId: string;
	planId: string;
	editToken: string;
	expectedHead: string;
	expectedTree: string;
	targetPlanFile: string;
	transientRefs: PlanTransientRef[];
	files: Array<{ name: string; mode: number; contentBase64: string }>;
}

function isPlanGraphFile(name: string): boolean {
	return name === "README.md" || name === "CONTEXT.md" || /^\d{3,}-.*\.md$/i.test(path.basename(name));
}

function planGraphFiles(planDirectory: string, directory = planDirectory): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (directory === planDirectory && entry.name === ".herder") continue;
		const candidate = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Plan graph path must not be a symlink: ${candidate}`);
		if (entry.isDirectory()) {
			files.push(...planGraphFiles(planDirectory, candidate));
			continue;
		}
		if (!entry.isFile()) continue;
		const relative = path.relative(planDirectory, candidate);
		if ((directory === planDirectory && (entry.name === "README.md" || entry.name === "CONTEXT.md")) || /^\d{3,}-.*\.md$/i.test(entry.name)) files.push(relative);
	}
	return files.sort();
}

function assertPlanGraphRelative(name: string): void {
	if (!name || path.isAbsolute(name) || name === ".." || name.startsWith(`..${path.sep}`) || !isPlanGraphFile(name)
		|| ((name === "README.md" || name === "CONTEXT.md") && path.dirname(name) !== ".")) throw new Error(`Unsafe plan graph path: ${name}`);
}

function safeEditToken(editToken: string): string {
	if (!/^[0-9a-f-]{36}$/i.test(editToken)) throw new Error("Plan edit token is invalid");
	return editToken.toLowerCase();
}

function ensurePrivateDirectory(candidate: string): void {
	try { fs.mkdirSync(candidate, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const stat = fs.lstatSync(candidate);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Plan edit runtime path must be a real directory: ${candidate}`);
	fs.chmodSync(candidate, 0o700);
}

function fsyncDirectory(candidate: string): void {
	const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
	try { fs.fsyncSync(descriptor); }
	finally { fs.closeSync(descriptor); }
}

function readRegularBytes(candidate: string, label: string): { bytes: Buffer; mode: number } {
	if (!fs.constants.O_NOFOLLOW) throw new Error(`Safe ${label} opening is unavailable`);
	const named = fs.lstatSync(candidate);
	if (named.isSymbolicLink() || !named.isFile()) throw new Error(`${label} must be a regular file: ${candidate}`);
	const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error(`${label} changed while opening: ${candidate}`);
		return { bytes: fs.readFileSync(descriptor), mode: opened.mode & 0o7777 };
	} finally { fs.closeSync(descriptor); }
}

export function reworkSnapshotPath(planDirectory: string, editToken: string): string {
	return path.join(planDirectory, ".herder", "plan-edits", `${safeEditToken(editToken)}.json`);
}

export function captureReworkSnapshot(run: StoredRun, planId: string, editToken: string, expectedHead: string, expectedTree: string, targetPlanFile: string, transientRefs: PlanTransientRef[]): { snapshot: ReworkGraphSnapshot; sha256: string } {
	const runtimeDirectory = path.join(run.planDirectory, ".herder");
	ensurePrivateDirectory(runtimeDirectory);
	const snapshotDirectory = path.join(runtimeDirectory, "plan-edits");
	ensurePrivateDirectory(snapshotDirectory);
	const names = planGraphFiles(run.planDirectory);
	if (!names.includes("README.md")) throw new Error("Plan edit snapshot requires README.md");
	const files = names.map((name) => {
		assertPlanGraphRelative(name);
		const file = readRegularBytes(path.join(run.planDirectory, name), "plan graph file");
		return { name, mode: file.mode, contentBase64: file.bytes.toString("base64") };
	});
	assertPlanGraphRelative(targetPlanFile);
	const snapshot: ReworkGraphSnapshot = { schemaVersion: 1, runId: run.runId, planId, editToken: safeEditToken(editToken), expectedHead, expectedTree, targetPlanFile, transientRefs, files };
	const json = stableJson(snapshot);
	const target = reworkSnapshotPath(run.planDirectory, editToken);
	const temporary = path.join(snapshotDirectory, `.${safeEditToken(editToken)}.${process.pid}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		fs.writeFileSync(descriptor, json);
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, target);
		fsyncDirectory(snapshotDirectory);
	} catch (error) {
		if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
		try { fs.unlinkSync(temporary); } catch {}
		throw error;
	}
	return { snapshot, sha256: sha256(json) };
}

export function readReworkSnapshotFile(run: StoredRun, edit: StoredPlanEdit): { snapshot: ReworkGraphSnapshot; sha256: string } {
	ensurePrivateDirectory(path.join(run.planDirectory, ".herder"));
	ensurePrivateDirectory(path.join(run.planDirectory, ".herder", "plan-edits"));
	const file = readRegularBytes(reworkSnapshotPath(run.planDirectory, edit.editToken), "plan edit snapshot");
	if (file.mode !== 0o600) throw new Error("Plan edit snapshot must have private mode 0600");
	let snapshot: ReworkGraphSnapshot;
	try { snapshot = JSON.parse(file.bytes.toString("utf8")) as ReworkGraphSnapshot; }
	catch { throw new Error("Plan edit snapshot is not valid JSON"); }
	if (stableJson(snapshot) !== file.bytes.toString("utf8") || snapshot.schemaVersion !== 1 || snapshot.runId !== run.runId
		|| snapshot.planId !== edit.planId || snapshot.editToken !== safeEditToken(edit.editToken)
		|| !/^[0-9a-f]{40,64}$/i.test(snapshot.expectedHead)
		|| !/^[0-9a-f]{40,64}$/i.test(snapshot.expectedTree)
		|| typeof snapshot.targetPlanFile !== "string"
		|| !Array.isArray(snapshot.transientRefs)
		|| !Array.isArray(snapshot.files) || snapshot.files.length === 0) {
		throw new Error("Plan edit snapshot identity is invalid");
	}
	assertPlanGraphRelative(snapshot.targetPlanFile);
	if (!snapshot.files.some((entry) => entry.name === snapshot.targetPlanFile)) throw new Error("Plan edit snapshot target file is missing");
	if (snapshot.transientRefs.some((entry, index) => !entry || typeof entry.ref !== "string" || typeof entry.target !== "string"
		|| !/^[0-9a-f]{40,64}$/i.test(entry.target) || (index > 0 && snapshot.transientRefs[index - 1]!.ref >= entry.ref))) {
		throw new Error("Plan edit snapshot transient refs are invalid");
	}
	const names = snapshot.files.map((entry) => entry.name);
	if (!names.includes("README.md") || names.some((name) => {
		try { assertPlanGraphRelative(name); return false; } catch { return true; }
	})
		|| names.some((name, index) => index > 0 && names[index - 1]! >= name)) throw new Error("Plan edit snapshot file set is invalid");
	for (const entry of snapshot.files) {
		if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777 || typeof entry.contentBase64 !== "string"
			|| Buffer.from(entry.contentBase64, "base64").toString("base64") !== entry.contentBase64) throw new Error(`Plan edit snapshot entry ${entry.name} is invalid`);
	}
	return { snapshot, sha256: sha256(stableJson(snapshot)) };
}

export function readReworkSnapshot(run: StoredRun, edit: StoredPlanEdit, store: RunStore): ReworkGraphSnapshot {
	const file = readReworkSnapshotFile(run, edit);
	store.validatePlanEditSnapshot(run.runId, edit.editToken, edit.planId, file.sha256);
	return file.snapshot;
}

export function restoreReworkSnapshot(run: StoredRun, edit: StoredPlanEdit, store: RunStore): void {
	const snapshot = readReworkSnapshot(run, edit, store);
	const current = planGraphFiles(run.planDirectory);
	for (const name of current) readRegularBytes(path.join(run.planDirectory, name), "current plan graph file");
	const retained = new Set(snapshot.files.map((entry) => entry.name));
	const temporaries: Array<{ temporary: string; target: string }> = [];
	try {
		for (const [index, entry] of snapshot.files.entries()) {
			const temporary = path.join(run.planDirectory, `.herder-plan-edit-${safeEditToken(edit.editToken)}-${index}.tmp`);
			try {
				const stale = fs.lstatSync(temporary);
				if (stale.isSymbolicLink() || !stale.isFile()) throw new Error(`Plan edit restore temporary is unsafe: ${temporary}`);
				fs.unlinkSync(temporary);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			try {
				fs.writeFileSync(descriptor, Buffer.from(entry.contentBase64, "base64"));
				fs.fchmodSync(descriptor, entry.mode);
				fs.fsyncSync(descriptor);
			} finally { fs.closeSync(descriptor); }
			temporaries.push({ temporary, target: path.join(run.planDirectory, entry.name) });
		}
		for (const name of current) if (!retained.has(name)) fs.unlinkSync(path.join(run.planDirectory, name));
		for (const entry of temporaries) {
			fs.mkdirSync(path.dirname(entry.target), { recursive: true });
			fs.renameSync(entry.temporary, entry.target);
		}
		fsyncDirectory(run.planDirectory);
	} finally {
		for (const entry of temporaries) try { fs.unlinkSync(entry.temporary); } catch {}
	}
}

export function deleteReworkSnapshotBestEffort(planDirectory: string, editToken: string): void {
	try {
		const candidate = reworkSnapshotPath(planDirectory, editToken);
		const stat = fs.lstatSync(candidate);
		if (!stat.isSymbolicLink() && stat.isFile()) fs.unlinkSync(candidate);
	} catch {}
}

export function pruneReworkSnapshots(planDirectory: string, retainedEditToken?: string): void {
	const directory = path.join(planDirectory, ".herder", "plan-edits");
	try {
		for (const name of fs.readdirSync(directory)) {
			if (!/^[0-9a-f-]{36}\.json$/i.test(name) || name === `${retainedEditToken?.toLowerCase()}.json`) continue;
			const candidate = path.join(directory, name);
			const stat = fs.lstatSync(candidate);
			if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Plan edit snapshot path is unsafe: ${candidate}`);
			fs.unlinkSync(candidate);
		}
		fsyncDirectory(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function reworkIndexLayout(markdown: string): { lines: string[]; newline: "\n" | "\r\n"; rows: Array<{ lineIndex: number; planId: string; statusStart: number; statusEnd: number }> } {
	const parsed = planIndexReworkLayout(markdown, "Herder plan index");
	return {
		lines: parsed.lines,
		newline: parsed.newline,
		rows: parsed.rows.map((row) => {
			const line = parsed.lines[row.lineIndex]!;
			const first = line.search(/\S|$/);
			const lastMatch = line.match(/\s*$/);
			const last = lastMatch ? line.length - lastMatch[0].length : line.length;
			const bodyStart = line[first] === "|" ? first + 1 : first;
			const bodyEnd = line[last - 1] === "|" ? last - 1 : last;
			const separators: number[] = [];
			for (let cursor = bodyStart; cursor < bodyEnd; cursor += 1) if (line[cursor] === "|") separators.push(cursor);
			const boundaries = [bodyStart, ...separators, bodyEnd];
			if (parsed.statusColumn >= boundaries.length - 1) throw new Error("Herder plan index status column is invalid");
			return {
				...row,
				statusStart: boundaries[parsed.statusColumn]!,
				statusEnd: boundaries[parsed.statusColumn + 1]!,
			};
		}),
	};
}

function normalizeReworkReadme(markdown: string, targetPlanId: string): string {
	const layout = reworkIndexLayout(markdown);
	for (const row of layout.rows) {
		const line = layout.lines[row.lineIndex]!;
		layout.lines[row.lineIndex] = row.planId === targetPlanId
			? `| <HERDER_REWORK_TARGET_${targetPlanId}> |`
			: `${line.slice(0, row.statusStart)} <HERDER_LIFECYCLE> ${line.slice(row.statusEnd)}`;
	}
	return layout.lines.join(layout.newline);
}

export function validateReworkGraphFiles(run: StoredRun, snapshot: ReworkGraphSnapshot, targetPlanFile: string): void {
	const currentNames = planGraphFiles(run.planDirectory);
	const expectedNames = snapshot.files.map((entry) => entry.name);
	if (!(currentNames.length === expectedNames.length && currentNames.every((value, index) => value === expectedNames[index]))) throw new Error("Rework cannot add, remove, or rename plan graph files");
	for (const entry of snapshot.files) {
		const current = readRegularBytes(path.join(run.planDirectory, entry.name), "plan graph file");
		if (current.mode !== entry.mode) throw new Error(`Rework changed the mode of ${entry.name}`);
		if (entry.name === targetPlanFile) continue;
		const original = Buffer.from(entry.contentBase64, "base64");
		if (entry.name === "README.md") {
			if (normalizeReworkReadme(original.toString("utf8"), snapshot.planId) !== normalizeReworkReadme(current.bytes.toString("utf8"), snapshot.planId)) {
				throw new Error(`Rework changed README content outside plan ${snapshot.planId} and lifecycle status cells`);
			}
		} else if (!current.bytes.equals(original)) {
			throw new Error(`Rework changed sibling graph file ${entry.name}`);
		}
	}
}

export function crashReworkForTest(point: "after_snapshot" | "after_git_cleanup" | "after_adoption"): void {
	if (process.env.HERDER_TEST_REWORK_CRASH_AT !== point) return;
	process.kill(process.pid, "SIGKILL");
}
