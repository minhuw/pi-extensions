import { join } from "node:path";
import { FOLLOWUP_RESULT_LIMIT } from "../config.ts";
import type { LaunchHandle, LaunchOutcome } from "./runtime.ts";

function serialize(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/** The single message the main session receives when a background launch settles. */
export function followUpText(outcome: LaunchOutcome, run: { runId: string; dir: string }): string {
	const lines = [
		`Herder launch ${outcome.launch} of run ${run.runId} ${outcome.status}.`,
		`Steps: ${outcome.reused} reused, ${outcome.changed} changed, ${outcome.new} new.`,
	];
	if (outcome.error) lines.push(`Error: ${outcome.error}`);
	if (outcome.value !== undefined) {
		const text = serialize(outcome.value);
		const where = outcome.resultRef ? ` (full value: ${join(run.dir, outcome.resultRef)})` : "";
		lines.push(text.length > FOLLOWUP_RESULT_LIMIT
			? `Return value, first ${FOLLOWUP_RESULT_LIMIT} characters${where}:\n${text.slice(0, FOLLOWUP_RESULT_LIMIT)}`
			: `Return value${where}:\n${text}`);
	} else lines.push("The script returned no value.");
	lines.push(outcome.status === "completed"
		? "Check the step results above, then continue: herder_check or herder_verify, or relaunch with a revised script."
		: `To retry, relaunch with herder_workflow { mode: "run", scriptPath: "${join(run.dir, "scripts", `${outcome.launch}.js`)}", resume: ${outcome.launch} } and the same args; finished steps are reused.`);
	return lines.join("\n");
}

const failure = (launch: number, error: unknown): LaunchOutcome =>
	({ launch, status: "failed", error: error instanceof Error ? error.message : String(error), reused: 0, changed: 0, new: 0 });

/**
 * A running launch. `onSettled` runs once with `silenced` true when its outcome was already reported elsewhere
 * (a stop that waited for it) or nobody should be told (abort, shutdown).
 */
export class BackgroundLaunch {
	readonly launch: number;
	readonly settled: Promise<LaunchOutcome>;
	readonly #handle: LaunchHandle;
	#outcome: LaunchOutcome | undefined;
	#silenced = false;

	constructor(handle: LaunchHandle, onSettled: (outcome: LaunchOutcome, silenced: boolean) => void) {
		this.launch = handle.launch;
		this.#handle = handle;
		this.settled = handle.done.catch((error: unknown) => failure(handle.launch, error)).then((outcome) => {
			this.#outcome = outcome;
			try { onSettled(outcome, this.#silenced); } catch {}
			return outcome;
		});
	}

	get outcome(): LaunchOutcome | undefined { return this.#outcome; }

	/** Stops the launch and waits up to `waitMs` for it to settle; the outcome is then the caller's to report. */
	async stop(reason: string, waitMs: number, silence: "always" | "if-settled"): Promise<LaunchOutcome | undefined> {
		this.#silenced = true;
		try { this.#handle.stop(reason); } catch {}
		await this.wait(waitMs);
		// Read the field, not wait()'s value: the outcome may land between the timeout and this line, already silenced.
		if (this.#outcome) return this.#outcome;
		if (silence === "if-settled") this.#silenced = false;
		return undefined;
	}

	async wait(ms: number): Promise<LaunchOutcome | undefined> {
		if (this.#outcome) return this.#outcome;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			const handle = setTimeout(resolve, ms, undefined);
			handle.unref?.();
			timer = handle;
		});
		try {
			return await Promise.race([this.settled, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
}
