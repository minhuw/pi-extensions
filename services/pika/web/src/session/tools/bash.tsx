import { CodeBlock, OutputBlock } from "../../components/code";
import { Callout, Pill } from "../../components/ui";
import { formatCount } from "../../lib/format";
import { argNumber, argString, PendingResult, ResultImages, resultText, type ToolRenderProps } from "./shared";

const EXIT_STATUS = /(?:^|\n\n)Command exited with code (-?\d+)\s*$/;

interface Truncation {
	truncated?: boolean;
	totalLines?: number;
	outputLines?: number;
	totalBytes?: number;
	outputBytes?: number;
}

export function parseBashOutput(text: string, isError: boolean): { output: string; exitCode: number | null } {
	const match = EXIT_STATUS.exec(text);
	if (match) return { output: text.slice(0, match.index), exitCode: Number(match[1]) };
	return { output: text, exitCode: isError ? null : 0 };
}

function truncationNote(details: unknown): string | null {
	if (!details || typeof details !== "object") return null;
	const { truncation, fullOutputPath } = details as { truncation?: Truncation; fullOutputPath?: string };
	if (!truncation?.truncated && !fullOutputPath) return null;
	const parts: string[] = [];
	if (truncation?.truncated) {
		parts.push(
			truncation.totalLines !== undefined && truncation.outputLines !== undefined
				? `Output truncated: showing ${formatCount(truncation.outputLines)} of ${formatCount(truncation.totalLines)} lines`
				: "Output truncated",
		);
	}
	if (fullOutputPath) parts.push(`full output in ${fullOutputPath}`);
	return parts.join("; ");
}

export function BashOutput({
	output,
	exitCode,
	isError,
	note,
}: {
	output: string;
	exitCode: number | null;
	isError: boolean;
	note?: string | null;
}) {
	const status = (
		<div className="mb-1 flex items-center gap-2 text-[13px] text-muted">
			<span>Output</span>
			{exitCode !== null ? (
				<Pill tone={exitCode === 0 ? "green" : "red"}>exit {exitCode}</Pill>
			) : isError ? (
				<Pill tone="red">failed</Pill>
			) : null}
		</div>
	);
	const body = (
		<>
			<OutputBlock text={output} />
			{note && <div className="mt-1 text-[13px] text-muted italic">{note}</div>}
		</>
	);
	if (isError) {
		return (
			<div className="mt-2">
				<Callout tone="red" title={exitCode !== null ? `Exited with code ${exitCode}` : "Command failed"}>
					{body}
				</Callout>
			</div>
		);
	}
	return (
		<div className="mt-2">
			{status}
			{body}
		</div>
	);
}

export function BashTool({ call, result }: ToolRenderProps) {
	const command = argString(call, "command", "cmd") ?? "";
	const timeout = argNumber(call, "timeout");
	const parsed = result ? parseBashOutput(resultText(result), result.isError) : null;
	return (
		<div>
			<CodeBlock code={command} language="bash" wrap />
			{timeout !== undefined && <div className="mt-1 text-[13px] text-muted">timeout {timeout}s</div>}
			{result && parsed ? (
				<>
					<BashOutput
						output={parsed.output}
						exitCode={parsed.exitCode}
						isError={result.isError}
						note={truncationNote(result.details)}
					/>
					<ResultImages result={result} />
				</>
			) : (
				<PendingResult />
			)}
		</div>
	);
}
