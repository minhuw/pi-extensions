// Test harness only: every Impeccable module/resource is loaded from argv[2].
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [installed, cwd, agentDir] = process.argv.slice(2);
const ext = path.join(installed, "extensions/impeccable");
const manifest = JSON.parse(await fsp.readFile(path.join(installed, "package.json"), "utf8"));
const attempts = [];
const sourceExtension = fileURLToPath(new URL("../../", import.meta.url));
function forbidSource(file) {
	const location = file instanceof URL ? fileURLToPath(file) : file;
	if (typeof location === "string" && path.resolve(location).startsWith(sourceExtension)) {
		attempts.push(`source fallback: ${location}`);
		throw new Error(`Activation attempted source fallback: ${location}`);
	}
}
registerHooks({ resolve(specifier, context, nextResolve) {
	const result = nextResolve(specifier, context);
	if (result.url.startsWith("file:")) forbidSource(new URL(result.url));
	return result;
} });
for (const [object, name] of [[fs, "readFile"], [fs, "readFileSync"], [fsp, "readFile"]]) {
	const original = object[name];
	object[name] = function (file, ...args) {
		forbidSource(file);
		return original.call(this, file, ...args);
	};
}
function block(object, names, category) {
	for (const name of names) {
		if (typeof object[name] !== "function") throw new Error(`Missing guard target: ${category}.${name}`);
		object[name] = (...args) => {
			const error = new Error(`Activation attempted ${category}.${name}`);
			attempts.push({ operation: `${category}.${name}`, target: String(args[0]), stack: error.stack });
			throw error;
		};
	}
}
block(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "process");
block(net, ["connect", "createConnection", "createServer"], "network");
block(net.Socket.prototype, ["connect"], "socket");
block(tls, ["connect", "createServer"], "tls");
block(http, ["request", "get", "createServer"], "http");
block(https, ["request", "get", "createServer"], "https");
block(dns, ["lookup", "resolve"], "dns");
block(dns.promises, ["lookup", "resolve"], "dnsPromise");
block(dgram, ["createSocket"], "udp");
block(globalThis, ["fetch", "WebSocket"], "global");
const mutations = ["writeFile", "appendFile", "mkdir", "mkdtemp", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "chmod", "chown", "truncate", "utimes", "symlink", "link"];
block(fsp, mutations, "fsPromise");
block(fs, [...mutations, ...mutations.map((name) => `${name}Sync`), "write", "writeSync", "writev", "writevSync", "createWriteStream"], "fs");
// Opening read-only files is allowed; guard file descriptors that could bypass writeFile.
for (const [object, name] of [[fs, "open"], [fs, "openSync"], [fsp, "open"]]) {
	const original = object[name];
	object[name] = function (file, flags, ...args) {
		forbidSource(file);
		if (flags !== "r" && flags !== fs.constants.O_RDONLY) {
			attempts.push(`fs.${name}:write`);
			throw new Error(`Activation attempted writable open: ${file}`);
		}
		return original.call(this, file, flags, ...args);
	};
}
syncBuiltinESMExports();

// Positive controls run before activation: failed/swallowed calls still leave evidence.
for (const probe of [
	() => childProcess.spawn(process.execPath, ["--version"]),
	() => fs.writeFileSync(path.join(cwd, "must never exist"), "bad"),
	() => fsp.writeFile(path.join(agentDir, "must never exist"), "bad"),
	() => fs.openSync(path.join(cwd, "must never exist"), "w"),
	() => globalThis.fetch("https://invalid.example"),
	() => net.connect(9, "127.0.0.1"),
	() => fs.readFileSync(path.join(sourceExtension, "skills/impeccable/SKILL.md")),
]) assert.throws(probe, /Activation attempted/);
assert.equal(attempts.length, 7);
attempts.length = 0;

const loader = new DefaultResourceLoader({
	cwd, agentDir, settingsManager: SettingsManager.inMemory(),
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [path.join(ext, "index.ts")],
	additionalSkillPaths: [path.join(ext, "skills")],
	additionalPromptTemplatePaths: manifest.pi.prompts.map((entry) => path.resolve(installed, entry)),
});
await loader.reload();
const { extensions, errors } = loader.getExtensions();
assert.deepEqual(errors, []);
assert.equal(extensions.length, 1);
assert.equal(extensions[0].resolvedPath, path.join(ext, "index.ts"));
const tools = [...extensions[0].tools.keys()].sort();
assert.deepEqual(tools, ["impeccable_capabilities", "impeccable_delegate", "impeccable_live", "impeccable_question", "impeccable_run"]);
assert.ok(extensions[0].handlers.size > 0, "lifecycle handlers must actually register");
assert.deepEqual(loader.getSkills().diagnostics, []);
const skills = loader.getSkills().skills;
assert.equal(skills.length, 1);
assert.equal(skills[0].baseDir, path.join(ext, "skills/impeccable"));
assert.equal(skills[0].filePath, path.join(ext, "skills/impeccable/SKILL.md"));
const { prompts, diagnostics } = loader.getPrompts();
assert.deepEqual(diagnostics, []);
assert.equal(prompts.length, manifest.pi.prompts.length);
assert.equal(new Set(prompts.map((prompt) => prompt.name)).size, prompts.length);
const { expandPromptTemplate } = await import(new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const ours = prompts.filter((prompt) => prompt.filePath.startsWith(ext + path.sep));
const metadata = JSON.parse(await fsp.readFile(path.join(ext, "skills/impeccable/scripts/command-metadata.json"), "utf8"));
assert.equal(Object.keys(metadata).length, 24);
assert.deepEqual(ours.map((prompt) => prompt.name).sort(), ["design", "impeccable", ...Object.keys(metadata).map((name) => `design-${name}`)].sort());
for (const prompt of ours) {
	assert.equal(prompt.filePath, path.join(ext, "prompts", `${prompt.name}.md`));
	const literal = "surface with spaces $1 $ARGUMENTS $(literal);";
	assert.equal(expandPromptTemplate(`/${prompt.name} "${literal}"`, prompts), prompt.content.replace("$ARGUMENTS", literal));
}
for (const name of ["polish", "review", "simplify", "deslop", "verify", "commit"]) {
	const prompt = prompts.find((candidate) => candidate.name === name);
	assert.ok(prompt);
	assert.equal(prompt.filePath, path.resolve(installed, manifest.pi.prompts.find((entry) => entry.endsWith(`/${name}.md`))));
}
assert.equal(manifest.pi.extensions.at(-1), "./extensions/pika/index.ts");
const resources = await import(pathToFileURL(path.join(ext, "src/resources.ts")).href);
for (const name of ["getSkillDir", "getScriptsDir", "getChecksumsPath", "getVersionPath", "getLauncherPath"]) {
	const location = resources[name]();
	assert.ok(location.startsWith(ext + path.sep));
	await fsp.stat(location);
}
assert.equal((await fsp.readFile(resources.getVersionPath(), "utf8")).trim(), "0.1.18");
assert.deepEqual(attempts, [], "including attempts caught internally by activation");
process.stdout.write(JSON.stringify({ tools, prompts: ours.length, guardControls: 7, activationAttempts: attempts }) + "\n");
