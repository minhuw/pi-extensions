#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
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
	host: "codex" | "claude" | "pi";
	output: string;
	tmpRoot?: string;
	environment?: NodeJS.ProcessEnv;
}

const TEXT_EXTENSIONS = new Set([
	".cfg", ".conf", ".css", ".html", ".ini", ".js", ".json", ".jsonl", ".log", ".md",
	".mjs", ".ndjson", ".sh", ".sql", ".toml", ".ts", ".txt", ".xml", ".yaml", ".yml",
]);

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
	return [...new Map(values.map((entry) => [entry.value, entry])).values()]
		.sort((left, right) => right.value.length - left.value.length);
}

function looksText(file: string, bytes: Buffer): boolean {
	if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
	return !bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
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

function copyEntry(source: string, destination: string, secrets: SecretPattern[], report: CollectionReport): void {
	const status = fs.lstatSync(source);
	if (status.isDirectory()) {
		fs.mkdirSync(destination, { recursive: true, mode: status.mode & 0o777 });
		for (const entry of fs.readdirSync(source).sort()) {
			copyEntry(path.join(source, entry), path.join(destination, entry), secrets, report);
		}
		return;
	}
	if (status.isSymbolicLink() || !status.isFile()) {
		report.skippedSpecialFiles.push(source);
		return;
	}

	let bytes = fs.readFileSync(source);
	const containsSecret = secrets.some((secret) => occurrences(bytes, secret.value) > 0);
	if (containsSecret && !looksText(source, bytes)) {
		report.omittedSensitiveFiles.push(source);
		return;
	}
	if (containsSecret) {
		let text = bytes.toString("utf8");
		for (const secret of secrets) {
			const count = text.split(secret.value).length - 1;
			if (count === 0) continue;
			text = text.split(secret.value).join(`[REDACTED:${secret.label}]`);
			report.redactedOccurrences[secret.label] = (report.redactedOccurrences[secret.label] || 0) + count;
		}
		bytes = Buffer.from(text);
	}
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.writeFileSync(destination, bytes, { mode: status.mode & 0o777 });
}

export function collectLiveArtifacts(options: CollectionOptions): CollectionReport {
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
	if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
		throw new Error(`Artifact output directory must be empty: ${output}`);
	}
	fs.mkdirSync(output, { recursive: true });
	const redactions = patterns(options.environment || process.env);
	const prefix = `herder-v010-${options.host}-`;
	for (const entry of fs.readdirSync(tmpRoot).filter((name) => name.startsWith(prefix)).sort()) {
		const workspace = path.join(tmpRoot, entry);
		if (!fs.lstatSync(workspace).isDirectory()) continue;
		report.workspaces.push(workspace);
		copyEntry(workspace, path.join(output, "fixtures", entry), redactions, report);
	}
	fs.writeFileSync(path.join(output, "README.txt"), [
		"Herder live E2E diagnostics",
		"",
		"fixtures/*/<host>.log is the root harness JSON/stream/RPC trajectory.",
		"fixtures/*/repository/herder-plans/.herder contains execution.sqlite3, service logs, assignments, and gate evidence.",
		"The fixture repository and Herder-owned worktrees contain only synthetic test data created by this job.",
		"manifest.json records redactions and any omitted sensitive binary files.",
		"",
	].join("\n"));
	fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
	return report;
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
	if (!new Set(["codex", "claude", "pi"]).has(host) || !output) throw new Error("usage: collect-live-artifacts.ts --host codex|claude|pi --output <directory> [--tmp-root <directory>]");
	return { host: host as CollectionOptions["host"], output, ...(tmpRoot ? { tmpRoot } : {}) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const report = collectLiveArtifacts(parse(process.argv.slice(2)));
		process.stdout.write(`${JSON.stringify({ ok: true, host: report.host, workspaces: report.workspaces.length })}\n`);
	} catch (error) {
		process.stderr.write(`collect-live-artifacts: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
