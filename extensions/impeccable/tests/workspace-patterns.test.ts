import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveProject, workspacePatternMatchesRel, workspaceSegmentMatches } from "../src/project.ts";

// Source vectors: pinned context.rs:1187; real binary comparison lives in test:impeccable:engine.
it.each([
	["*", "anything", true], ["*", "", true],
	["web[1]", "web[1]", true], ["web[1]", "web1", false],
	["web?", "web?", true], ["web?", "web1", false],
	["{web,app}", "{web,app}", true], ["{web,app}", "web", false],
	["@(web)", "@(web)", true], ["@(web)", "web", false],
	["web+(1)", "web+(1)", true], ["web+(1)", "web1", false],
	["web[1]*", "web[1]-ui", true], ["web[1]*", "web1-ui", false],
	["*?", "web?", true], ["*?", "web1", false],
	["*{web,app}", "my{web,app}", true], ["*{web,app}", "myweb", false],
	["*(web)", "my(web)", true], ["*(web)", "myweb", false],
	["*.$^+|\\", "literal.$^+|\\", true], ["*.$^+|\\", "literalX", false],
	["w**b", "web", true], ["w**b", "w/a/b", false],
	["*x", "x\n", false], ["*x", "\nx", true],
] as const)("matches pinned segment %j against %j = %s", (pattern, segment, expected) => {
	expect(workspaceSegmentMatches(pattern, segment)).toBe(expected);
});

it.each([
	["apps/web[1]", "apps/web[1]/src", true], ["apps/web[1]", "apps/web1/src", false],
	["apps/web[1]*", "apps/web[1]-ui/src", true], ["apps/web[1]*", "apps/web1-ui/src", false],
	["apps/*", "apps/web/src", true], ["apps/*", "apps", false],
	["apps/**/ignored-suffix", "apps/web/src", true], ["apps/**/ignored-suffix", "apps", false],
	["apps/w*/**/ignored-suffix", "apps/peer", true],
	["apps/[web]/**", "apps/[web]/ui/src", true], ["apps/[web]/**", "apps/w/ui", false],
	["apps/***/src", "apps/web/src/nested", true], ["apps/***/src", "apps/web/other/src", false],
	["**/literal", "anything", true], ["", "apps/web", false],
	[" './apps/*/' ", "apps/web/src", true],
] as const)("matches pinned path prefix %j against %j = %s", (pattern, relative, expected) => {
	expect(workspacePatternMatchesRel(pattern, relative.split("/"))).toBe(expected);
});

it.each([
	["web[1]", "web1", "web[1]"], ["web[1]*", "web1-ui", "web[1]-ui"],
	["web?*", "web1-ui", "web?-ui"], ["{web,app}*", "web-ui", "{web,app}-ui"],
	["@(web)*", "web-ui", "@(web)-ui"], ["web+(1)*", "web1-ui", "web+(1)-ui"],
])("shares literal %s semantics across discovery, positive boundaries and exclusions", async (pattern, peer, literal) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-impeccable-pattern-")));
	try {
		await fs.mkdir(path.join(root, ".git")); await fs.mkdir(path.join(root, ".impeccable"));
		for (const name of [peer, literal]) {
			await fs.mkdir(path.join(root, "apps", name, "src"), { recursive: true });
			await fs.writeFile(path.join(root, "apps", name, "package.json"), '{}');
			await fs.writeFile(path.join(root, "apps", name, "src/DESIGN.md"), "Nested source context must not replace an explicit app boundary.");
		}
		const config = path.join(root, ".impeccable/config.json");
		// Positive discovery and source boundary use the same literal matcher.
		await fs.writeFile(config, JSON.stringify({ projectRoots: [`apps/${pattern}`] }));
		expect(await resolveProject(root, literal)).toBe(path.join(root, "apps", literal));
		await expect(resolveProject(root, peer)).rejects.toThrow("Unresolved target");
		expect(await resolveProject(root, `apps/${literal}/src/new.tsx`)).toBe(path.join(root, "apps", literal));
		// Explicit exclusions remain authoritative even across a candidate Git boundary.
		await fs.mkdir(path.join(root, "apps", literal, ".git"));
		await fs.writeFile(config, JSON.stringify({ projectRoots: ["apps/*", `!apps/${pattern}`] }));
		await expect(resolveProject(root, literal)).rejects.toThrow("Unresolved target");
		expect(await resolveProject(root, peer)).toBe(path.join(root, "apps", peer));
		// Direct existing paths deliberately retain their separate child-Git semantics.
		expect(await resolveProject(root, `apps/${literal}`)).toBe(path.join(root, "apps", literal));
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
