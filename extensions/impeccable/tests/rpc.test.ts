import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["dismissed", "cancelled"] as const)("preserves actual partial answers through Pi's RPC dialog protocol on %s", async (lastOutcome) => {
	const directory = await mkdtemp(join(tmpdir(), "impeccable rpc dialogs-"));
	const extension = join(directory, "rpc-fixture.ts");
	const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	await writeFile(extension, `
import impeccable from ${JSON.stringify(entry)};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default function(pi) {
 const faux = fauxProvider({ api: "impeccable-rpc-api", provider: "impeccable-rpc", models: [{ id: "test" }] });
 pi.registerProvider(faux.provider);
 impeccable(pi);
 faux.setResponses([
  fauxAssistantMessage([fauxToolCall("impeccable_question", { questions: [
   { id: "direction", question: "Approve?", choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
   { id: "intent", question: "Purpose?" }, { id: "detail", question: "Anything else?" }
  ] })]),
  fauxAssistantMessage("Only actual answers recorded; final question is still pending.")
 ]);
}
`);
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", extension, "--provider", "impeccable-rpc", "--model", "test"], {
		cwd: directory,
		env: { ...process.env, PI_CODING_AGENT_DIR: directory },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (data) => { stderr += String(data); });
	const methods: string[] = [];
	const toolResults: Array<Record<string, unknown>> = [];
	let buffer = "";
	const send = (data: unknown) => child.stdin.write(`${JSON.stringify(data)}\n`);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RPC timed out: ${stderr}`)), 15_000);
			child.on("error", reject);
			child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`RPC exited ${code}: ${stderr}`)); });
			child.stdout.on("data", (data) => {
				buffer += String(data);
				while (buffer.includes("\n")) {
					const index = buffer.indexOf("\n");
					const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
					let event;
					try { event = JSON.parse(line); } catch { continue; }
					if (event.type === "extension_ui_request") {
						methods.push(event.method);
						if (event.method === "select") send({ type: "extension_ui_response", id: event.id, value: "[no] No" });
						else if (event.method === "input" && methods.length === 2) send({ type: "extension_ui_response", id: event.id, value: "Actual user purpose" });
						else if (lastOutcome === "cancelled") send({ type: "abort" });
						else send({ type: "extension_ui_response", id: event.id, cancelled: true });
					}
					if (event.type === "tool_execution_end" && event.toolName === "impeccable_question") toolResults.push(event.result);
					if (event.type === "agent_settled") { clearTimeout(timer); resolve(); }
				}
			});
			send({ type: "prompt", message: "Ask design questions now" });
		});
		expect(methods).toEqual(["select", "input", "input"]);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.details).toMatchObject({ status: lastOutcome, answers: [{ id: "direction", choiceId: "no", value: "No" }, { id: "intent", value: "Actual user purpose" }], pending: [{ id: "detail" }] });
	} finally {
		const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
		child.kill("SIGTERM");
		await exited;
		await rm(directory, { recursive: true, force: true });
	}
});
