import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const clean = (value: unknown): string => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 240) : "";
interface TitleState { managed: boolean; parent: boolean; prompt: boolean; labels: string[]; foreignCount?: () => number }
export class Titles {
	private timer: ReturnType<typeof setInterval> | undefined;
	private frame = 0;
	private ctx: ExtensionContext | undefined;
	private state: TitleState | undefined;
	private painted = false;
	private disposed = false;
	update(ctx: ExtensionContext | undefined, state: TitleState): void {
		if (this.disposed) return;
		this.ctx = ctx;
		this.state = state;
		this.stopTimer();
		if (state.managed && (state.parent || state.prompt)) { this.painted = false; return; }
		if (state.managed && !state.labels.length && !state.foreignCount?.() && !this.painted) return;
		if (!this.paint()) return;
		if (!state.prompt && this.painted) {
			this.timer = setInterval(() => { if (!this.paint() || !this.painted) this.stopTimer(); }, 100);
			this.timer.unref?.();
		}
	}
	private paint(): boolean {
		if (this.disposed || !this.ctx || !this.state) return false;
		try {
			const ctx = this.ctx;
			if (ctx.mode !== "tui") return false;
			const ui = ctx.ui;
			if (typeof ui?.setTitle !== "function") return false;
			let name = "";
			let cwd = "";
			try { name = clean(ctx.sessionManager?.getSessionName()); } catch { /* invalidated context */ }
			try { cwd = clean(ctx.cwd); } catch { /* invalidated context */ }
			const { parent, prompt, labels } = this.state;
			const foreign = this.state.foreignCount?.() ?? 0;
			const busy = parent || labels.length > 0 || foreign > 0;
			const marker = prompt ? "π !" : busy ? `${FRAMES[this.frame++ % FRAMES.length]} π :` : "π >";
			const activity = prompt ? "Waiting for input" : busy ? [parent ? "Working" : "", ...labels.slice(0, 3), labels.length > 3 ? `+${labels.length - 3}` : "", foreign ? `${foreign} external ${foreign === 1 ? "activity" : "activities"}` : ""].filter(Boolean).join(" · ") : "";
			ui.setTitle(`${marker} ${[name, activity].filter(Boolean).join(" · ")}${cwd ? ` - ${cwd}` : ""}`.trim());
			this.painted = busy;
			return true;
		} catch { return false; }
	}
	private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
	close(): void {
		if (this.disposed) return;
		this.stopTimer();
		if (this.state && (this.painted || (!this.state.managed && this.state.prompt))) {
			this.state = { ...this.state, parent: false, prompt: false, labels: [] };
			this.paint();
		}
		this.disposed = true;
		this.ctx = undefined;
		this.state = undefined;
	}
}
