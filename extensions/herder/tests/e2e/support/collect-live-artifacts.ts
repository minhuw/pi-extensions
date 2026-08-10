#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

interface SecretPattern {
	label: string;
	value: string;
}

interface CollectionReport {
	host: string;
	generatedAt: string;
	workspaces: string[];
	redactedOccurrences: Record<string, number>;
	omittedSensitiveFiles: string[];
	skippedSpecialFiles: string[];
}

export interface CollectionOptions {
	host: "pi";
	output: string;
	tmpRoot?: string;
	environment?: NodeJS.ProcessEnv;
}

const TEXT_EXTENSIONS = new Set([
	".cfg", ".conf", ".css", ".html", ".ini", ".js", ".json", ".jsonl", ".log", ".md",
	".mjs", ".ndjson", ".sh", ".sql", ".toml", ".ts", ".txt", ".xml", ".yaml", ".yml",
]);
const WORKSPACE_PREFIX = "herder-pi-live-";
const EXECUTION_DATABASE_NAME = "execution.sqlite3";
const EXECUTION_DATABASE_SIDECARS = new Set(["execution.sqlite3-wal", "execution.sqlite3-shm"]);
const SERVICE_TOKEN_LABEL = "HERDER_SERVICE_AUTH_TOKEN";
const SERVICE_TOKEN_MARKER = `[REDACTED:${SERVICE_TOKEN_LABEL}]`;

function patterns(environment: NodeJS.ProcessEnv): SecretPattern[] {
	const values: SecretPattern[] = [];
	const key = environment.CLIPROXY_API_KEY?.trim();
	const base = environment.CLIPROXY_BASE_URL?.trim().replace(/\/$/, "");
	if (key) values.push({ label: "CLIPROXY_API_KEY", value: key });
	if (base) {
		const root = base.replace(/\/(?:v1|backend-api)$/, "");
		for (const value of new Set([`${root}/backend-api`, `${root}/v1`, base, root])) {
			if (value) values.push({ label: "CLIPROXY_BASE_URL", value });
		}
	}
	return mergePatterns(values);
}

function mergePatterns(...groups: SecretPattern[][]): SecretPattern[] {
	return [...new Map(groups.flat().filter((entry) => entry.value).map((entry) => [entry.value, entry])).values()]
		.sort((left, right) => right.value.length - left.value.length);
}

function looksText(file: string, bytes: Buffer): boolean {
	if (bytes.includes(0)) return false;
	const controls = bytes.some((byte) => byte !== 0x1b && (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f));
	if (controls) return false;
	if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

interface TextSpan {
	start: number;
	end: number;
}

interface NormalizedText {
	value: string;
	sourceOffsets: number[];
}

function ansiSequenceEnd(text: string, offset: number): number | undefined {
	if (text.charCodeAt(offset) !== 0x1b) return undefined;
	const next = text.charCodeAt(offset + 1);
	if (next === 0x5b) {
		for (let cursor = offset + 2; cursor < text.length; cursor += 1) {
			const code = text.charCodeAt(cursor);
			if (code >= 0x40 && code <= 0x7e) return cursor + 1;
		}
		return undefined;
	}
	if (next >= 0x20 && next <= 0x7e) return offset + 2;
	return undefined;
}

function normalizeAnsiText(text: string): NormalizedText {
	const values: string[] = [];
	const sourceOffsets: number[] = [];
	for (let index = 0; index < text.length;) {
		const sequenceEnd = ansiSequenceEnd(text, index);
		if (sequenceEnd !== undefined) {
			index = sequenceEnd;
			continue;
		}
		const codePoint = text.codePointAt(index);
		const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
		values.push(text.slice(index, index + width));
		for (let offset = 0; offset < width; offset += 1) sourceOffsets.push(index + offset);
		index += width;
	}
	return { value: values.join(""), sourceOffsets };
}

function textSpans(text: string, value: string): TextSpan[] {
	const spans: TextSpan[] = [];
	if (!value) return spans;
	let offset = 0;
	while ((offset = text.indexOf(value, offset)) !== -1) {
		spans.push({ start: offset, end: offset + value.length });
		offset += value.length;
	}
	return spans;
}

function normalizedTextSpans(text: string, value: string): TextSpan[] {
	const normalized = normalizeAnsiText(text);
	const spans: TextSpan[] = [];
	if (!value) return spans;
	let offset = 0;
	while ((offset = normalized.value.indexOf(value, offset)) !== -1) {
		const start = normalized.sourceOffsets[offset];
		const endOffset = normalized.sourceOffsets[offset + value.length - 1];
		if (start === undefined || endOffset === undefined) break;
		spans.push({ start, end: endOffset + 1 });
		offset += value.length;
	}
	return spans;
}

function ansiSpansContaining(text: string, value: string): TextSpan[] {
	const spans: TextSpan[] = [];
	if (!value) return spans;
	for (let index = 0; index < text.length;) {
		const sequenceEnd = ansiSequenceEnd(text, index);
		if (sequenceEnd !== undefined) {
			if (text.slice(index, sequenceEnd).includes(value)) spans.push({ start: index, end: sequenceEnd });
			index = sequenceEnd;
			continue;
		}
		const codePoint = text.codePointAt(index);
		index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
	}
	return spans;
}

function mergeTextSpans(spans: TextSpan[]): TextSpan[] {
	const merged: TextSpan[] = [];
	for (const span of [...spans].sort((left, right) => left.start - right.start || left.end - right.end)) {
		const previous = merged.at(-1);
		if (!previous || span.start >= previous.end) {
			merged.push({ ...span });
		} else {
			previous.end = Math.max(previous.end, span.end);
		}
	}
	return merged;
}

function replaceAnsiSpan(text: string, span: TextSpan, replacement: string, secretValue: string): string {
	let result = "";
	let inserted = false;
	for (let index = span.start; index < span.end;) {
		const sequenceEnd = ansiSequenceEnd(text, index);
		if (sequenceEnd !== undefined && sequenceEnd <= span.end) {
			if (!text.slice(index, sequenceEnd).includes(secretValue)) result += text.slice(index, sequenceEnd);
			index = sequenceEnd;
			continue;
		}
		if (!inserted) {
			result += replacement;
			inserted = true;
		}
		const codePoint = text.codePointAt(index);
		index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
	}
	return inserted ? result : replacement;
}

function redactText(text: string, secret: SecretPattern): { text: string; count: number } {
	const spans = mergeTextSpans([
		...textSpans(text, secret.value),
		...normalizedTextSpans(text, secret.value),
		...ansiSpansContaining(text, secret.value),
	]);
	if (spans.length === 0) return { text, count: 0 };
	const replacement = `[REDACTED:${secret.label}]`;
	let redacted = "";
	let offset = 0;
	for (const span of spans) {
		redacted += text.slice(offset, span.start);
		redacted += replaceAnsiSpan(text, span, replacement, secret.value);
		offset = span.end;
	}
	return { text: redacted + text.slice(offset), count: spans.length };
}

function occurrences(bytes: Buffer, value: string): number {
	const needle = Buffer.from(value);
	let count = 0;
	let offset = 0;
	while (needle.length > 0 && (offset = bytes.indexOf(needle, offset)) !== -1) {
		count += 1;
		offset += needle.length;
	}
	return count;
}

function isExecutionDatabase(file: string): boolean {
	return path.basename(file) === EXECUTION_DATABASE_NAME && path.basename(path.dirname(file)) === ".herder";
}

function isExecutionDatabaseSidecar(file: string): boolean {
	return EXECUTION_DATABASE_SIDECARS.has(path.basename(file));
}

function databaseTables(database: DatabaseSync): string[] {
	const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name?: unknown }>;
	return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function tableRowCounts(database: DatabaseSync): Map<string, number> {
	const counts = new Map<string, number>();
	for (const table of databaseTables(database)) {
		const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count?: unknown } | undefined;
		const count = Number(row?.count);
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Execution database row count is invalid");
		counts.set(table, count);
	}
	return counts;
}

function assertQuickCheck(database: DatabaseSync, label: string): void {
	const row = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
	const result = String(Object.values(row ?? {})[0] ?? "");
	if (result !== "ok") throw new Error(`Execution database failed quick_check ${label}: ${result || "unknown error"}`);
}

function assertSameRowCounts(before: Map<string, number>, after: Map<string, number>): void {
	if (before.size !== after.size) throw new Error("Execution database row retention validation failed");
	for (const [table, count] of before) {
		if (after.get(table) !== count) throw new Error("Execution database row retention validation failed");
	}
}

function serviceAuthToken(database: DatabaseSync): string {
	const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_service'").get() as { name?: unknown } | undefined;
	if (!table) throw new Error("Execution database service schema is missing manager_service");
	const columns = database.prepare("PRAGMA table_info(manager_service)").all() as Array<{ name?: unknown }>;
	if (!columns.some((column) => column.name === "auth_token")) {
		throw new Error("Execution database service schema is missing auth_token");
	}
	const row = database.prepare("SELECT auth_token FROM manager_service WHERE singleton = 1").get() as { auth_token?: unknown } | undefined;
	if (typeof row?.auth_token !== "string" || row.auth_token.length === 0) {
		throw new Error("Execution database does not contain a service credential");
	}
	if (SERVICE_TOKEN_MARKER.includes(row.auth_token)) {
		throw new Error("Execution database service credential cannot be represented by the replacement marker");
	}
	return row.auth_token;
}

function redactDatabaseText(database: DatabaseSync, secrets: SecretPattern[]): void {
	if (secrets.length === 0) return;
	for (const table of databaseTables(database)) {
		const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: unknown }>;
		for (const column of columns) {
			if (typeof column.name !== "string" || column.name.length === 0) continue;
			const identifier = quoteIdentifier(column.name);
			const statement = database.prepare(`UPDATE ${quoteIdentifier(table)} SET ${identifier} = REPLACE(${identifier}, ?, ?) WHERE typeof(${identifier}) = 'text' AND instr(${identifier}, ?) > 0`);
			for (const secret of secrets) {
				statement.run(secret.value, `[REDACTED:${secret.label}]`, secret.value);
			}
		}
	}
}

async function sanitizeDatabase(source: string, destination: string, privateDirectory: string, providerSecrets: SecretPattern[]): Promise<SecretPattern[]> {
	fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
	fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
	const backupPath = path.join(privateDirectory, "backup.sqlite3");
	const compactPath = path.join(privateDirectory, "compact.sqlite3");
	let sourceDatabase: DatabaseSync | undefined;
	let workingDatabase: DatabaseSync | undefined;
	try {
		sourceDatabase = new DatabaseSync(source, { readOnly: true });
		await backup(sourceDatabase, backupPath);
		workingDatabase = new DatabaseSync(backupPath);
		workingDatabase.exec("PRAGMA busy_timeout = 5000");
		workingDatabase.exec("PRAGMA journal_mode = DELETE");
		assertQuickCheck(workingDatabase, "before sanitization");
		const retainedRows = tableRowCounts(workingDatabase);
		const authToken = serviceAuthToken(workingDatabase);
		const databaseSecrets = mergePatterns(providerSecrets, [{ label: SERVICE_TOKEN_LABEL, value: authToken }]);

		workingDatabase.exec("BEGIN IMMEDIATE");
		try {
			const replacement = workingDatabase.prepare("UPDATE manager_service SET auth_token = ? WHERE singleton = 1").run(SERVICE_TOKEN_MARKER);
			if (Number(replacement.changes) !== 1) throw new Error("Execution database service credential replacement failed");
			redactDatabaseText(workingDatabase, providerSecrets);
			workingDatabase.exec("COMMIT");
		} catch (error) {
			try {
				workingDatabase.exec("ROLLBACK");
			} catch {
				// Preserve the original sanitization failure.
			}
			throw error;
		}
		assertQuickCheck(workingDatabase, "after sanitization");
		assertSameRowCounts(retainedRows, tableRowCounts(workingDatabase));
		const replaced = workingDatabase.prepare("SELECT auth_token FROM manager_service WHERE singleton = 1").get() as { auth_token?: unknown } | undefined;
		if (replaced?.auth_token !== SERVICE_TOKEN_MARKER) throw new Error("Execution database replacement marker was not retained");
		workingDatabase.prepare("VACUUM INTO ?").run(compactPath);
		workingDatabase.close();
		workingDatabase = undefined;

		const compactedDatabase = new DatabaseSync(compactPath, { readOnly: true });
		try {
			assertQuickCheck(compactedDatabase, "after compaction");
			assertSameRowCounts(retainedRows, tableRowCounts(compactedDatabase));
			const compactedService = compactedDatabase.prepare("SELECT auth_token FROM manager_service WHERE singleton = 1").get() as { auth_token?: unknown } | undefined;
			if (compactedService?.auth_token !== SERVICE_TOKEN_MARKER) throw new Error("Execution database replacement marker was not retained after compaction");
		} finally {
			compactedDatabase.close();
		}

		const compactedBytes = fs.readFileSync(compactPath);
		for (const secret of databaseSecrets) {
			if (occurrences(compactedBytes, secret.value) !== 0) throw new Error(`Execution database still contains ${secret.label}`);
		}
		fs.renameSync(compactPath, destination);
		return databaseSecrets;
	} finally {
		workingDatabase?.close();
		sourceDatabase?.close();
		fs.rmSync(backupPath, { force: true });
		fs.rmSync(compactPath, { force: true });
	}
}

function findDatabaseSources(source: string, found: string[] = []): string[] {
	const status = fs.lstatSync(source);
	if (!status.isDirectory()) return found;
	for (const entry of fs.readdirSync(source).sort()) {
		const child = path.join(source, entry);
		const childStatus = fs.lstatSync(child);
		if (childStatus.isDirectory()) findDatabaseSources(child, found);
		else if (childStatus.isFile() && isExecutionDatabase(child)) found.push(child);
	}
	return found;
}

async function copyEntry(source: string, destination: string, secrets: SecretPattern[], handledDatabases: Set<string>, report: CollectionReport): Promise<void> {
	const status = fs.lstatSync(source);
	if (status.isDirectory()) {
		fs.mkdirSync(destination, { recursive: true, mode: status.mode & 0o777 });
		for (const entry of fs.readdirSync(source).sort()) {
			await copyEntry(path.join(source, entry), path.join(destination, entry), secrets, handledDatabases, report);
		}
		return;
	}
	if (status.isSymbolicLink() || !status.isFile()) {
		report.skippedSpecialFiles.push(source);
		return;
	}
	if (isExecutionDatabase(source)) {
		if (!handledDatabases.has(source)) throw new Error(`Execution database was not sanitized: ${source}`);
		return;
	}
	if (isExecutionDatabaseSidecar(source)) {
		report.omittedSensitiveFiles.push(source);
		return;
	}

	let bytes = fs.readFileSync(source);
	if (!looksText(source, bytes)) {
		report.omittedSensitiveFiles.push(source);
		return;
	}
	let text = bytes.toString("utf8");
	let redactedAny = false;
	for (const secret of secrets) {
		const redacted = redactText(text, secret);
		if (redacted.count === 0) continue;
		text = redacted.text;
		redactedAny = true;
		report.redactedOccurrences[secret.label] = (report.redactedOccurrences[secret.label] || 0) + redacted.count;
	}
	if (redactedAny) bytes = Buffer.from(text);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.writeFileSync(destination, bytes, { mode: status.mode & 0o777 });
}

function outputExists(output: string): boolean {
	try {
		const status = fs.lstatSync(output);
		if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`Artifact output must be a real directory: ${output}`);
		if (fs.readdirSync(output).length > 0) throw new Error(`Artifact output directory must be empty: ${output}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function placeOutput(stagedOutput: string, output: string, existed: boolean): void {
	if (!existed) {
		fs.renameSync(stagedOutput, output);
		return;
	}
	try {
		fs.renameSync(stagedOutput, output);
	} catch (error) {
		if (!fs.existsSync(output) || fs.readdirSync(output).length > 0) throw error;
		fs.rmSync(output, { recursive: true, force: true });
		fs.renameSync(stagedOutput, output);
	}
}

export async function collectLiveArtifacts(options: CollectionOptions): Promise<CollectionReport> {
	const tmpRoot = path.resolve(options.tmpRoot || os.tmpdir());
	const output = path.resolve(options.output);
	const report: CollectionReport = {
		host: options.host,
		generatedAt: new Date().toISOString(),
		workspaces: [],
		redactedOccurrences: {},
		omittedSensitiveFiles: [],
		skippedSpecialFiles: [],
	};
	const existed = outputExists(output);
	if (!existed) fs.mkdirSync(path.dirname(output), { recursive: true });
	const workspacePaths: string[] = [];
	for (const entry of fs.readdirSync(tmpRoot).filter((name) => name.startsWith(WORKSPACE_PREFIX)).sort()) {
		const workspace = path.join(tmpRoot, entry);
		if (!fs.lstatSync(workspace).isDirectory()) continue;
		workspacePaths.push(workspace);
		report.workspaces.push(workspace);
	}

	const stagingRoot = fs.mkdtempSync(path.join(path.dirname(output), ".herder-live-artifacts-"));
	const stagedOutput = path.join(stagingRoot, "output");
	fs.mkdirSync(stagedOutput, { recursive: true, mode: 0o700 });
	try {
		const databaseSources = workspacePaths.flatMap((workspace) => findDatabaseSources(workspace));
		const configuredSecrets = patterns(options.environment || process.env);
		const handledDatabases = new Set<string>();
		const databaseSecrets: SecretPattern[] = [];
		for (const [index, source] of databaseSources.entries()) {
			const workspace = workspacePaths.find((candidate) => source === candidate || source.startsWith(`${candidate}${path.sep}`));
			if (!workspace) throw new Error("Execution database workspace could not be determined");
			const destination = path.join(stagedOutput, "fixtures", path.basename(workspace), path.relative(workspace, source));
			databaseSecrets.push(...await sanitizeDatabase(source, destination, path.join(stagingRoot, "databases", String(index)), configuredSecrets));
			handledDatabases.add(source);
		}
		const redactions = mergePatterns(configuredSecrets, databaseSecrets);
		for (const workspace of workspacePaths) {
			await copyEntry(workspace, path.join(stagedOutput, "fixtures", path.basename(workspace)), redactions, handledDatabases, report);
		}
		fs.writeFileSync(path.join(stagedOutput, "README.txt"), [
			"Herder live E2E diagnostics",
			"",
			"fixtures/*/<host>.log is the root harness JSON/stream/RPC trajectory.",
			"fixtures/*/repository/herder-plans/.herder contains execution.sqlite3, service logs, assignments, and gate evidence.",
			"The fixture repository and Herder-owned worktrees contain only synthetic test data created by this job.",
			"manifest.json records redactions and any omitted sensitive binary files.",
			"",
		].join("\n"));
		fs.writeFileSync(path.join(stagedOutput, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
		placeOutput(stagedOutput, output, existed);
		return report;
	} finally {
		fs.rmSync(stagingRoot, { recursive: true, force: true });
	}
}

function parse(argv: string[]): CollectionOptions {
	let host = "";
	let output = "";
	let tmpRoot: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const option = argv[index];
		const value = argv[++index];
		if (!value || !["--host", "--output", "--tmp-root"].includes(option || "")) throw new Error(`Invalid artifact collector option: ${option || "<missing>"}`);
		if (option === "--host") host = value;
		else if (option === "--output") output = value;
		else tmpRoot = value;
	}
	if (host !== "pi" || !output) throw new Error("usage: collect-live-artifacts.ts --host pi --output <directory> [--tmp-root <directory>]");
	return { host: host as CollectionOptions["host"], output, ...(tmpRoot ? { tmpRoot } : {}) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const report = await collectLiveArtifacts(parse(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify({ ok: true, host: report.host, workspaces: report.workspaces.length })}\n`);
	} catch (error) {
		process.stderr.write(`collect-live-artifacts: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
