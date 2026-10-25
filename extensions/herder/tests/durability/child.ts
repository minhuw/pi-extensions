// Child process for the exit variant: launches the run and exits at the planned fault, so no `finally` runs.
// argv: <repo dir> <fault JSON> <report path>. Exits with CRASH_EXIT at the fault, 0 if the launch settles without it.
import { writeFileSync } from "node:fs";
import { CRASH_EXIT, launch, rig, taskOf, type Fault } from "./support.ts";

const [dir, faultJson, report] = process.argv.slice(2) as [string, string, string];
const { faults, runner } = rig(JSON.parse(faultJson) as Fault, (point, key) => {
	writeFileSync(report, JSON.stringify({ point, key, calls: runner.calls.map((call) => taskOf(call.prompt)) }));
	process.exit(CRASH_EXIT);
});
const outcome = await launch(dir, runner, faults);
writeFileSync(report, JSON.stringify({ outcome }));
