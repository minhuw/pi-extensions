import net from "node:net";

/** One TCP connect attempt; localhost servers may listen on IPv4 or IPv6 only, so both loopbacks count. */
export async function tcpOpen(port: number): Promise<boolean> {
	return (await connect("127.0.0.1", port)) || (await connect("::1", port));
}

function connect(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(1000, () => done(false));
		socket.once("connect", () => done(true));
		// Refused, unreachable, or no IPv6: the port is not open for this probe.
		socket.once("error", () => done(false));
	});
}

/** True when `url` answers with a status below 500 within 2 s. */
export async function httpUp(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
		await response.body?.cancel();
		return response.status < 500;
	} catch {
		// Network errors and the timeout abort mean "not up yet"; the URL was validated at start.
		return false;
	}
}

/**
 * Runs `probe` every `intervalMs` (never overlapping) until it returns true, then calls
 * `onOpen` once. Returns a function that stops the loop.
 */
export function pollUntil(probe: () => Promise<boolean>, intervalMs: number, onOpen: () => void): () => void {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const tick = async () => {
		const open = await probe();
		if (stopped) return;
		if (open) {
			stopped = true;
			onOpen();
			return;
		}
		timer = setTimeout(tick, intervalMs);
	};
	void tick();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
