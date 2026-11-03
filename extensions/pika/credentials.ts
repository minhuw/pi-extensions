import { isExcluded, type ConfigResult } from "./config.ts";
import { resolveRepository, type RepositoryInfo } from "./repository.ts";

/**
 * The process-global registry through which pika shares its active server credentials with its relay
 * and recall parts, including module copies loaded for other cwds. Either side may create it first.
 */
export const CREDENTIALS = Symbol.for("pi-extensions.pika.credentials");

export interface PikaCredentials {
	url: string;
	token: string;
	/** Whether pika's `exclude` patterns cover `cwd`. */
	isExcluded(cwd: string): boolean;
}

export interface CredentialsRegistry {
	/** Set while pika is enabled with a URL and token; undefined when it is disabled, logged out, or unconfigured. */
	current: PikaCredentials | undefined;
	/** Called after every change of `current`. */
	listeners: Set<() => void>;
	/**
	 * Resolves the git repository of `cwd` as pika files its sessions: `project` is the repository's
	 * name (the main checkout's folder, also from a subdirectory or linked worktree) and `repository`
	 * its web URL without credentials; both are absent outside git. Cached per cwd, it never rejects
	 * and settles within a few seconds. Set by pika whatever its login; older pika versions lack it.
	 */
	repository?: (cwd: string) => Promise<RepositoryInfo>;
}

const global = globalThis as { [CREDENTIALS]?: CredentialsRegistry };
export const credentialsRegistry = (): CredentialsRegistry => {
	const registry = global[CREDENTIALS] ??= { current: undefined, listeners: new Set() };
	registry.repository ??= resolveRepository;
	return registry;
};

/**
 * What identifies published credentials, kept on the object under a `Symbol.for` key so module
 * copies loaded for other cwds agree; a config that reads the same changes nothing.
 */
const KEY = Symbol.for("pi-extensions.pika.credentials.key");
type Keyed = PikaCredentials & { [KEY]?: string };

/** Publishes the credentials of `config`, telling the listeners when they changed. */
export function publishCredentials(config: ConfigResult): void {
	const registry = credentialsRegistry();
	const enabled = config.enabled ? config.config : undefined;
	const key = enabled ? JSON.stringify([enabled.url, enabled.token, enabled.exclude]) : undefined;
	const before = registry.current as Keyed | undefined;
	if (before === undefined ? key === undefined : before[KEY] !== undefined && before[KEY] === key) return;
	if (enabled) {
		const exclude = [...enabled.exclude];
		const current: Keyed = { url: enabled.url, token: enabled.token, isExcluded: (cwd) => isExcluded(cwd, exclude) };
		Object.defineProperty(current, KEY, { value: key });
		registry.current = current;
	} else registry.current = undefined;
	for (const listener of [...registry.listeners]) {
		try { listener(); } catch { /* a listener's failure is its own */ }
	}
}
