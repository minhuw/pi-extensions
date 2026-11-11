/** Inner-protocol errors (NODE.md §7, "Inner error codes"). */
import type { ReplyError } from "./protocol.ts";

export class NodeError extends Error {
    readonly code: string;
    readonly current: ReplyError["current"];
    constructor(code: string, message: string, current?: ReplyError["current"]) {
        super(message);
        this.code = code;
        this.current = current;
    }
}

const ERRNO: Record<string, string> = { ENOENT: "not_found", EEXIST: "exists", EACCES: "permission_denied", EPERM: "permission_denied", EISDIR: "is_a_directory", ENOTDIR: "not_a_directory" };

export function asNodeError(error: unknown): NodeError {
    if (error instanceof NodeError) return error;
    const errno = (error as NodeJS.ErrnoException)?.code;
    if (typeof errno === "string") return new NodeError(ERRNO[errno] ?? "io", ERRNO[errno] ? (error as Error).message : errno);
    return new NodeError("io", (error as Error)?.message ?? String(error));
}
