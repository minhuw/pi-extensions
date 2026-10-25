import { useMemo } from "react";
import { CodeBlock, OutputBlock } from "../../components/code";
import { Toggle } from "../../components/ui";
import { unifiedDiff, type DiffLine } from "../../lib/diff";
import { languageForPath } from "../../lib/highlight";
import { args, argNumber, argString, okResult, PendingResult, ResultImages, resultText, type ToolRenderProps } from "./shared";

export function toolPath(call: ToolRenderProps["call"]): string | undefined {
	return argString(call, "path", "file_path", "filePath");
}

function PathLine({ path, detail }: { path: string | undefined; detail?: string }) {
	return (
		<div className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
			<span className="mono break-all">{path ?? "(no path)"}</span>
			{detail && <span className="text-[13px] text-muted">{detail}</span>}
		</div>
	);
}

export function readRange(offset: number | undefined, limit: number | undefined): string | undefined {
	if (offset === undefined && limit === undefined) return undefined;
	const start = offset ?? 1;
	return limit !== undefined ? `lines ${start}–${start + limit - 1}` : `from line ${start}`;
}

export function ReadTool({ call, result }: ToolRenderProps) {
	const path = toolPath(call);
	const ok = okResult(result);
	return (
		<div>
			<PathLine path={path} detail={readRange(argNumber(call, "offset"), argNumber(call, "limit"))} />
			{ok ? (
				<div className="mt-2">
					{resultText(ok) && <CodeBlock code={resultText(ok)} language={languageForPath(path)} />}
					<ResultImages result={ok} />
				</div>
			) : (
				!result && <PendingResult />
			)}
		</div>
	);
}

interface EditPair {
	oldText: string;
	newText: string;
}

export function editPairs(call: ToolRenderProps["call"]): EditPair[] {
	const values = args(call);
	if (Array.isArray(values.edits)) {
		return values.edits
			.filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === "object")
			.map((edit) => ({
				oldText: typeof edit.oldText === "string" ? edit.oldText : String(edit.old_string ?? ""),
				newText: typeof edit.newText === "string" ? edit.newText : String(edit.new_string ?? ""),
			}));
	}
	const oldText = argString(call, "oldText", "old_string");
	const newText = argString(call, "newText", "new_string");
	return oldText !== undefined || newText !== undefined ? [{ oldText: oldText ?? "", newText: newText ?? "" }] : [];
}

const DIFF_STYLE: Record<DiffLine["kind"], { sign: string; className: string }> = {
	add: { sign: "+", className: "bg-green-soft text-green" },
	del: { sign: "-", className: "bg-red-soft text-red" },
	context: { sign: " ", className: "" },
};

export function DiffView({ lines }: { lines: DiffLine[] }) {
	return (
		<pre className="code-block !px-0" style={{ maxHeight: "28rem" }} data-diff="">
			{lines.map((line, index) => {
				const style = DIFF_STYLE[line.kind];
				return (
					<div key={index} className={`px-3 ${style.className}`} data-diff-line={line.kind}>
						<span className="mr-2 inline-block w-3 select-none opacity-70">{style.sign}</span>
						{line.text}
					</div>
				);
			})}
		</pre>
	);
}

export function EditTool({ call, result }: ToolRenderProps) {
	const path = toolPath(call);
	const diffs = useMemo(() => editPairs(call).map((pair) => unifiedDiff(pair.oldText, pair.newText)), [call]);
	const added = diffs.reduce((n, lines) => n + lines.filter((l) => l.kind === "add").length, 0);
	const removed = diffs.reduce((n, lines) => n + lines.filter((l) => l.kind === "del").length, 0);
	return (
		<div>
			<PathLine
				path={path}
				detail={`${diffs.length} edit${diffs.length === 1 ? "" : "s"} · +${added} −${removed}`}
			/>
			<div className="mt-2 space-y-2">
				{diffs.map((lines, index) => (
					<DiffView key={index} lines={lines} />
				))}
			</div>
			{!result && <PendingResult />}
		</div>
	);
}

export function WriteTool({ call, result }: ToolRenderProps) {
	const path = toolPath(call);
	const content = argString(call, "content") ?? "";
	const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
	const ok = okResult(result);
	return (
		<div>
			<PathLine path={path} />
			<Toggle className="mt-1 text-[14px]" label={<span className="text-muted">Content · {lines} line{lines === 1 ? "" : "s"}</span>}>
				<CodeBlock code={content} language={languageForPath(path)} />
			</Toggle>
			{ok && resultText(ok) && <div className="mt-1 text-[13px] text-muted">{resultText(ok)}</div>}
			{!result && <PendingResult />}
		</div>
	);
}

export function CodemodeTool({ call, result }: ToolRenderProps) {
	const code = argString(call, "code", "script", "source") ?? "";
	const ok = okResult(result);
	return (
		<div>
			<CodeBlock code={code} language="javascript" />
			{ok ? (
				<div className="mt-2">
					<div className="mb-1 text-[13px] text-muted">Output</div>
					<OutputBlock text={resultText(ok)} />
					<ResultImages result={ok} />
				</div>
			) : (
				!result && <PendingResult />
			)}
		</div>
	);
}
