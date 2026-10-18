import { StringDecoder } from "node:string_decoder";

/** Consume Pi's LF-delimited stdout without throwing from a stream callback. */
export function createPiRpcMonitor() {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let failure: string | undefined;
	return {
		consume(chunk: Buffer): void {
			pending += decoder.write(chunk);
			let newline: number;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				if (!line || failure) continue;
				try {
					const record = JSON.parse(line);
					if (record?.type === "response" && record.success === false) {
						failure = `Pi RPC ${record.command ?? "command"} failed: ${record.error ?? "no detail"}`;
					} else if (record?.type === "extension_error") {
						failure = `Pi extension ${record.extensionPath ?? "unknown"} failed: ${record.error ?? "no detail"}`;
					} else if (record?.type === "extension_ui_request") {
						if (record.method === "notify" && record.notifyType === "error") {
							failure = `Pi reported an error: ${record.message ?? "no detail"}`;
						} else if (["select", "confirm", "input", "editor"].includes(record.method)) {
							failure = `Pi requested interactive ${record.method}: ${record.title ?? "no detail"}`;
						}
					}
				} catch {
					failure = "Pi RPC emitted invalid JSON on stdout; inspect pi.log.";
				}
			}
		},
		assertHealthy(): void {
			if (failure) throw new Error(failure);
		},
	};
}
