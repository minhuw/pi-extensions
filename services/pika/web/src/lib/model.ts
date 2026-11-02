/**
 * A model id's bare name, as pika shows it and as the server reports it (`util::bare_model`): the part after the last
 * `/` (a router or provider prefix such as `codex/` or `google/`), without an `@` and what follows it (a parameter
 * such as `@500k`), trimmed. An id that would leave nothing stays as it is, trimmed.
 */
export function bareModel(id: string): string {
	const trimmed = id.trim();
	const name = trimmed.slice(trimmed.lastIndexOf("/") + 1).split("@")[0].trim();
	return name || trimmed;
}

/** `bareModel` for an optional id; blank ids are no model. */
export function bareModelOf(id: unknown): string | undefined {
	return typeof id === "string" && id.trim() ? bareModel(id) : undefined;
}
