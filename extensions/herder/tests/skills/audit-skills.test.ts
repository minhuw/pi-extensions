// The bundled herder-improve and herder-simplify audit skills: metadata, references, and the Herder flow they follow.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { auditSkillDir } from "../../src/adapter/prompts.ts";

const SKILLS = [
	{ kind: "improve", name: "herder-improve", references: ["references/audit-playbook.md"], extra: ["LICENSE.md", "UPSTREAM.md"] },
	{ kind: "simplify", name: "herder-simplify", references: ["references/simplification-playbook.md"], extra: [] },
] as const;
const V1_TERMS = new RegExp([
	"\\bFire\\b", "\\bGrill\\b", "\\bJudges?\\b", "\\bImplementers?\\b", "herder_plan", "Plan V2", "herder-plans", "CONTEXT\\.md", "herder-validate",
	"worker authority", "worker setup", "\\b[AVT] rows\\b", "\\bT definitions?\\b", "STOP condition", "spike plan", "final[- ]manager", "\\breservations?\\b",
	"planText", "PlanContract", "GitDriver", "leak/", "operator attention", "acceptance-phase", "suggested[- ]route", "binding design", "gate-passing prerequisite",
	"Implementation route", "Escalation and handoff", "Starting conditions", "Write paths", "\\b[AV][1-9]\\d*\\b",
].join("|"));

describe("Herder v1 vocabulary", () => {
	it("flags v1 plan terms but not Herder's own vocabulary", () => {
		for (const phrase of ["Run /herder-validate first", "worker authority for restoration", "add A rows and V rows", "the T definitions", "a STOP condition", "write a spike plan", "the final-manager gate", "a path reservation", "the Judge decides"]) expect(phrase).toMatch(V1_TERMS);
		const herder = readFileSync(join(auditSkillDir("improve"), "..", "herder", "SKILL.md"), "utf8");
		for (const text of [herder, "- [ ] T1 (AC-1) Preserve the contract", "verify: judge — rubric", "no spike leftovers", "the preserved behavior"]) expect(text).not.toMatch(V1_TERMS);
	});
});

describe.each(SKILLS)("$name", ({ kind, name, references, extra }) => {
	const dir = auditSkillDir(kind);
	const text = readFileSync(join(dir, "SKILL.md"), "utf8");

	it("has frontmatter Pi loads, with its name and a description", () => {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(text);
		expect(frontmatter.name).toBe(name);
		expect(String(frontmatter.description).length).toBeGreaterThan(40);
		const { skills, diagnostics } = loadSkillsFromDir({ dir: join(dir, ".."), source: "test" });
		expect(skills.map((skill) => skill.name)).toContain(name);
		expect(diagnostics.filter((item) => item.path?.startsWith(dir))).toEqual([]);
	});

	it("ships its references and stays well under 400 lines", () => {
		for (const path of [...references, ...extra]) expect(existsSync(join(dir, path)), path).toBe(true);
		for (const path of references) expect(text).toContain(path);
		expect(text.split("\n").length).toBeLessThan(400);
		if (kind === "improve") expect(readFileSync(join(dir, "LICENSE.md"), "utf8")).toContain("MIT License");
	});

	it("ends in a picked Herder run", () => {
		for (const term of ["herder_pick_findings", 'herder_run { action: "start", goal }', 'herder_run { action: "approve_goal" }', "--auto", "--lang", "`branch`", "disjoint.js"]) expect(text).toContain(term);
		expect(text).toMatch(/cancelled or selected none, stop: start no run/);
		expect(text).toContain("/herder <goal>");
		expect(text).toMatch(/recommended findings and every finding they depend on, transitively/);
		expect(text).toMatch(/Checks that prove one finding get `integrate: no` and are that task's `gate`/);
		expect(text).toMatch(/`max_agents` about 5 per selected finding .* at most 400/);
		expect(text).toMatch(/more than about 15 findings are selected, say so and recommend narrowing/);
		expect(text).toMatch(/These rules bind the audit, until `herder_run \{ action: "start" \}`/);
	});

	it("contains no Herder v1 concepts", () => {
		for (const path of ["SKILL.md", ...references, ...extra]) expect(readFileSync(join(dir, path), "utf8"), path).not.toMatch(V1_TERMS);
	});
});
