/**
 * A terminal's raw output on disk: the current generation `<path>` and one previous generation `<path>.1`.
 * Adapted from extensions/processes/src/core/logfile.ts (copied, not imported: services import no extension).
 */
import fs from "node:fs";

export class LogFile {
    readonly path: string;
    #maxBytes: number;
    #fd: number | undefined;
    #size = 0;

    constructor(path: string, maxBytes: number) {
        if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error(`log maxBytes must be a positive integer, got ${maxBytes}`);
        this.path = path;
        this.#maxBytes = maxBytes;
    }

    append(data: Buffer): void {
        let offset = 0;
        while (offset < data.length) {
            if (this.#size >= this.#maxBytes) this.#rotate();
            const length = Math.min(this.#maxBytes - this.#size, data.length - offset);
            this.#fd ??= fs.openSync(this.path, "a", 0o600);
            fs.writeSync(this.#fd, data, offset, length);
            this.#size += length;
            offset += length;
        }
    }

    close(): void {
        if (this.#fd === undefined) return;
        fs.closeSync(this.#fd);
        this.#fd = undefined;
    }

    remove(): void {
        this.close();
        fs.rmSync(this.path, { force: true });
        fs.rmSync(`${this.path}.1`, { force: true });
    }

    #rotate(): void {
        this.close();
        fs.renameSync(this.path, `${this.path}.1`);
        this.#size = 0;
    }
}
