// Replay: a playhead sweeping the gap-folded timeline. Positions are active milliseconds.

export const REPLAY_SPEEDS = [1, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayState {
	status: "stopped" | "playing" | "paused";
	speed: ReplaySpeed;
	position: number;
	duration: number;
}

export type ReplayAction =
	| { type: "play" }
	| { type: "pause" }
	| { type: "toggle" }
	| { type: "stop" }
	/** `dt` wall-clock milliseconds passed while playing. */
	| { type: "tick"; dt: number }
	| { type: "seek"; position: number }
	| { type: "speed"; speed: ReplaySpeed }
	/** Reduced motion: jump to the next stop (record start) instead of sweeping. */
	| { type: "step"; stops: number[] }
	| { type: "duration"; duration: number };

export function initialReplay(duration: number): ReplayState {
	return { status: "stopped", speed: 10, position: 0, duration: Math.max(0, duration) };
}

function clamp(state: ReplayState, position: number): number {
	return Math.max(0, Math.min(state.duration, position));
}

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
	switch (action.type) {
		case "play":
			// Playing at the end starts over.
			return { ...state, status: "playing", position: state.position >= state.duration ? 0 : state.position };
		case "pause":
			return state.status === "playing" ? { ...state, status: "paused" } : state;
		case "toggle":
			return replayReducer(state, { type: state.status === "playing" ? "pause" : "play" });
		case "stop":
			return { ...state, status: "stopped", position: 0 };
		case "tick": {
			if (state.status !== "playing") return state;
			const position = clamp(state, state.position + Math.max(0, action.dt) * state.speed);
			return { ...state, position, status: position >= state.duration ? "paused" : "playing" };
		}
		case "seek":
			// Scrubbing a stopped replay pauses it at the new position.
			return { ...state, position: clamp(state, action.position), status: state.status === "stopped" ? "paused" : state.status };
		case "speed":
			return { ...state, speed: action.speed };
		case "step": {
			if (state.status !== "playing") return state;
			const next = action.stops.find((stop) => stop > state.position + 0.5);
			if (next === undefined) return { ...state, position: state.duration, status: "paused" };
			return { ...state, position: clamp(state, next) };
		}
		case "duration":
			return { ...state, duration: Math.max(0, action.duration), position: Math.min(state.position, Math.max(0, action.duration)) };
	}
}

/** Index of the last stop at or before `position`, or -1 before the first. */
export function currentStop(stops: number[], position: number): number {
	let lo = 0;
	let hi = stops.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (stops[mid] <= position) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}
