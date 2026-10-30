// Protocol fixture, executed as a local trusted override; this is not the upstream engine.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const skill = process.env.IMPECCABLE_SKILL_DIR;
const self = process.env.IMPECCABLE_SELF;
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
process.stdout.write(JSON.stringify({
	argv: process.argv.slice(2), cwd: process.cwd(), stdin,
	skill, self, provider: process.env.IMPECCABLE_PROVIDER_ID,
	literal: process.env.PACKAGE_LITERAL,
	skillExists: fs.statSync(path.join(skill, "SKILL.md")).isFile(),
	launcherExists: fs.statSync(self).isFile(),
	version: fs.readFileSync(path.join(skill, "scripts/VERSION"), "utf8").trim(),
	checksums: createHash("sha256").update(fs.readFileSync(path.join(skill, "scripts/engine-checksums.txt"))).digest("hex"),
}) + "\n");
if (process.argv[2] === "detect") process.exitCode = 2;
if (process.argv[2] === "fail") { process.stderr.write("protocol fixture failure\n"); process.exitCode = 7; }
