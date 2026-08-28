import fs from "node:fs";
import path from "node:path";

const INDEPENDENT_PLAN_ROW = /(\| \[001\]\(001-update-value\.md\).*\|\n)/;

export function appendIndependentPlan({ planDirectory }: { planDirectory: string }): void {
	const readmePath = path.join(planDirectory, "README.md");
	const readme = fs.readFileSync(readmePath, "utf8");
	if (!INDEPENDENT_PLAN_ROW.test(readme)) {
		throw new Error("README is missing the 001-update-value.md index row");
	}
	const second = fs.readFileSync(path.join(planDirectory, "001-update-value.md"), "utf8")
		.replaceAll("Plan 001", "Plan 002")
		.replaceAll("fixture value", "other fixture value")
		.replaceAll("src/value.mjs", "src/other.mjs")
		.replaceAll("`value`", "`other`");
	const updatedReadme = readme.replace(
		INDEPENDENT_PLAN_ROW,
		"$1| [002](002-update-other.md) | Update the other fixture value | P1 | S | — | TODO |\n",
	);
	fs.writeFileSync(readmePath, updatedReadme);
	fs.writeFileSync(path.join(planDirectory, "002-update-other.md"), second);
}
