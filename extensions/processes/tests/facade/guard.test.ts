import { describe, expect, it } from "vitest";
import { BACKGROUND_REASON, findBackgrounding, registerBashGuard } from "../../src/guard.ts";
import { createCtx, createPi } from "./fakes.ts";

const flagged: [string, string][] = [
	["npm run dev &", "&"],
	["npm run dev&", "&"],
	["npm run dev & sleep 5 && curl localhost:3000", "&"],
	["(npm run dev &)", "&"],
	["x & disown", "&"],
	["nohup x", "nohup"],
	["nohup x > out.log 2>&1", "nohup"],
	["setsid x", "setsid"],
	["/usr/bin/nohup x", "nohup"],
	["cd app && nohup npm start", "nohup"],
	["true; setsid -f server", "setsid"],
	["FOO=1 nohup x", "nohup"],
	["sudo nohup x", "nohup"],
	["if true; then server & fi", "&"],
	["echo $(server &)", "&"],
	["echo `nohup x`", "nohup"],
	["a | b &", "&"],
	["server 2>&1 &", "&"],
	["server &> log &", "&"],
	["cat <<EOF\nbody & more\nEOF\nserver &", "&"],
	["echo '&' ; server &", "&"],
	["echo hi # comment\nserver &", "&"],
	["disown", "disown"],
	["case x in a) server & ;; esac", "&"],
];

const allowed = [
	"npm test && npm run build",
	"a || b",
	"make 2>&1 | tee log",
	"echo err >&2",
	"cmd &>file",
	"cmd &>>file",
	"cmd |& tee log",
	"echo 'a & b'",
	'echo "a & b"',
	"echo a \\& b",
	"echo hi # run me &",
	"# nohup x &",
	"cat <<EOF\nnohup x &\nEOF",
	"cat <<'EOF'\nsetsid y &\nEOF\necho done",
	"cat <<-EOF\n\tserver &\n\tEOF",
	"grep nohup file.txt",
	"echo setsid disown",
	"ls ./nohup-logs",
	"git log --grep='&'",
	"echo $((1 & 3))",
	"(( x = 5 & 3 ))",
	'echo "${var:-a & b}"',
	"echo ${x//&/and}",
	"case x in a) echo a;; b) echo b;& c) echo c;;& esac",
	"exec 3<&0",
	"cmd >|file",
	"echo a\\\nb",
	"",
];

describe("findBackgrounding", () => {
	it.each(flagged)("flags %j", (command, construct) => {
		expect(findBackgrounding(command)).toBe(construct);
	});

	it.each(allowed.map((command) => [command]))("allows %j", (command) => {
		expect(findBackgrounding(command)).toBeUndefined();
	});
});

describe("registerBashGuard", () => {
	it("blocks backgrounding bash calls only", async () => {
		const pi = createPi();
		registerBashGuard(pi.api);
		const ctx = createCtx("s");
		expect(await pi.fire("tool_call", { toolName: "bash", input: { command: "npm run dev &" } }, ctx)).toEqual([{ block: true, reason: BACKGROUND_REASON }]);
		expect(await pi.fire("tool_call", { toolName: "bash", input: { command: "npm test" } }, ctx)).toEqual([undefined]);
		expect(await pi.fire("tool_call", { toolName: "write", input: { command: "x &" } }, ctx)).toEqual([undefined]);
	});
});
