/**
 * One terminal's pane status (NODE.md, "Pane status"): the OSC 7501 program status and the bridge status,
 * merged into a `PaneView` with the daemon's unread flag.
 */
import { becameDone, mergeState, type BridgeStatus, type PaneState, type PaneView, type ProgramStatus } from "./protocol.ts";

export class Pane {
    program: ProgramStatus | undefined;
    /** The PTY's foreground process when the program status arrived; a change clears the status. */
    programProcess: string | undefined;
    bridge: BridgeStatus | undefined;
    bridgeConnected = false;
    unread = false;
    exited = false;
    #state: PaneState = "idle";
    #last = "null";

    view(): PaneView | null {
        if (this.exited || (!this.program && !this.bridge)) return null;
        return {
            state: this.#state,
            ...(this.program ? { program: this.program } : {}),
            ...(this.bridge ? { bridge: this.bridge } : {}),
            bridgeConnected: this.bridgeConnected,
            unread: this.unread,
        };
    }

    /** Recomputes the merged state and unread flag; true when the view changed. */
    #update(): boolean {
        const next = mergeState(this.program, this.bridge);
        if (becameDone(this.#state, next)) this.unread = true;
        this.#state = next;
        const text = JSON.stringify(this.view());
        if (text === this.#last) return false;
        this.#last = text;
        return true;
    }

    setProgram(status: ProgramStatus | "clear", foreground: string | undefined): boolean {
        if (status === "clear") {
            this.program = undefined;
            this.programProcess = undefined;
        } else {
            if (status.state === "error" && this.program?.state !== "error") this.unread = true;
            this.program = status;
            this.programProcess = foreground;
        }
        return this.#update();
    }

    /** The foreground poll: a different process in front means the program that reported is gone. */
    foreground(process: string | undefined): boolean {
        if (!this.program || process === this.programProcess) return false;
        return this.setProgram("clear", undefined);
    }

    setBridge(status: BridgeStatus): boolean {
        this.bridge = status;
        this.bridgeConnected = true;
        return this.#update();
    }

    bridgeClosed(): boolean {
        this.bridgeConnected = false;
        return this.#update();
    }

    seen(): boolean {
        this.unread = false;
        return this.#update();
    }

    exit(): boolean {
        this.exited = true;
        return this.#update();
    }
}
