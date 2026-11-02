import { describe, expect, it } from "vitest";
import { parseModels } from "../index.ts";
import { addMagpieModelAliases, assertMagpieAliasRoute, MagpieAliasRouteError, resolveMagpieAlias, type MagpieAliasFailure, type MagpieModel } from "../model-aliases.ts";

const name = "claude-opus-5-5";
const raw = { owned_by: "claude1", native_endpoints: ["/v1/messages"], context_window: 100000,
	modalities: { input: ["text", "image"] }, custom_metadata: { ordered: [1, 2], flag: true } };
const parse = (data: unknown[]) => parseModels({ data }, "https://gateway.example");
const aliases = (models: MagpieModel[]) => models.filter(model => model.magpieAliasTarget !== undefined);
const single = () => parse([{ ...raw, id: `claude1/${name}` }]);
const aliasOf = (models: MagpieModel[]) => aliases(models)[0];

describe("source-aware catalog aliases", () => {
	it("keeps originals, proves a shortened clone, and reserves the short name for auto", () => {
		const models = parse([
			{ ...raw, id: `claude1/${name}` },
			{ ...raw, id: `claude1/nested/${name}` },
			{ ...raw, id: `auto/${name}` },
		]);
		// Two different concrete routes remain ambiguous even with the same owner and raw metadata.
		expect(aliases(models).map(model => model.magpieAliasTarget)).toEqual([`auto/${name}`]);
		const entries = [{ ...raw, id: `claude1/nested/${name}` }, { ...raw, id: `nested/${name}` }, { ...raw, id: `auto/${name}` }];
		const actual = parse(entries);
		expect(actual.map(model => model.id)).toEqual([...entries.map(row => row.id), name]);
		expect(actual[0].magpieRoute).toEqual({ canonicalId: entries[0].id, owner: "claude1", group: false });
		expect(actual[1].magpieRoute).toEqual(actual[0].magpieRoute);
		expect(actual[2].magpieRoute).toEqual({ canonicalId: entries[2].id, owner: "claude1", group: true });
		expect(actual[3]).toEqual({ ...actual[2], id: name, name, magpieAliasTarget: entries[2].id });
		expect(entries[0]).not.toHaveProperty("magpieRoute");
	});

	it.each(["auto", "group"])("prioritizes a proven %s clone over owned_by's concrete counterpart", root => {
		const models = parse([
			{ ...raw, id: `${root}/${name}` }, { ...raw, id: name }, { ...raw, id: `claude1/${name}` },
		]);
		expect(models[1].magpieRoute).toEqual({ canonicalId: `${root}/${name}`, owner: "claude1", group: true });
		expect(models[2].magpieRoute?.group).toBe(false);
		expect(aliases(models)).toEqual([]);
	});

	it("does not treat a group's first-member owner as a concrete alias source", () => {
		const models = parse([{ ...raw, id: `auto/${name}` }, { ...raw, id: `group/${name}` }]);
		expect(models.map(model => model.magpieRoute?.canonicalId)).toEqual([`auto/${name}`, `group/${name}`, `auto/${name}`]);
		expect(aliasOf(models).magpieRoute?.group).toBe(true);
	});

	it.each([
		{ ...raw, custom_metadata: { ordered: [2, 1], flag: true } },
		{ ...raw, context_window: 200000 },
		{ ...raw, extra: undefined },
	])("does not collapse shortened rows with different raw metadata: %j", metadata => {
		const models = parse([{ ...raw, id: `claude1/nested/${name}` }, { ...metadata, id: `nested/${name}` }]);
		expect(models[1].magpieRoute?.canonicalId).toBe(`nested/${name}`);
		expect(aliases(models)).toEqual([]);
	});

	it("compares raw objects deeply without relying on property order", () => {
		const models = parse([{ ...raw, id: `claude1/nested/${name}` },
			{ ...raw, custom_metadata: { flag: true, ordered: [1, 2] }, id: `nested/${name}` }]);
		expect(aliasOf(models).magpieAliasTarget).toBe(`claude1/nested/${name}`);
	});

	it("resolves proven prefix chains with a stable target regardless of source order", () => {
		const entries = ["nested", "claude1/nested", "claude1/claude1/nested"].map(prefix => ({ ...raw, id: `${prefix}/${name}` }));
		for (const order of [entries, [...entries].reverse()]) {
			const models = parse(order);
			expect(models.every(model => model.magpieRoute?.canonicalId === entries[2].id)).toBe(true);
			expect(aliasOf(models).magpieAliasTarget).toBe(entries[2].id);
		}
	});

	it("keeps different providers distinct despite the same final name and raw metadata", () => {
		const models = parse([{ ...raw, id: `claude1/${name}` }, { ...raw, owned_by: "claude2", id: `claude2/${name}` }]);
		expect(models.map(model => model.magpieRoute?.canonicalId)).toEqual([`claude1/${name}`, `claude2/${name}`]);
		expect(aliases(models)).toEqual([]);
	});

	it.each([undefined, null, "", "bad owner", "nested/owner", "*", "..", "claude1\n"])("does not synthesize aliases for missing or unsafe owner %j", owned_by => {
		const models = parse([{ ...raw, owned_by, id: `claude1/${name}` }]);
		expect(aliases(models)).toEqual([]);
		const ambiguous = parse([{ ...raw, id: `claude1/${name}` }, { ...raw, owned_by, id: `unknown/${name}` }]);
		expect(aliases(ambiguous)).toEqual([]);
	});

	it("requires ownership of the concrete namespace", () => {
		expect(aliases(parse([{ ...raw, id: `other/${name}` }]))).toEqual([]);
	});

	it("does not shadow an advertised bare ID, even a proven concrete clone", () => {
		const models = parse([{ ...raw, id: `claude1/${name}` }, { ...raw, id: name }]);
		expect(models).toHaveLength(2);
		expect(models[1].magpieRoute?.canonicalId).toBe(`claude1/${name}`);
		expect(models[1].magpieAliasTarget).toBeUndefined();
		expect(resolveMagpieAlias(models[1])).toBe(models[1]);
	});

	it.each([name, "claude-3-7-sonnet", "claude-new-family@500k-build-fast"])("retains the exact Claude family name %s", id => {
		const models = parse([{ ...raw, id: `claude1/${id}` }]);
		expect(aliasOf(models)).toMatchObject({ id, name: id, magpieAliasTarget: `claude1/${id}` });
	});

	it.each(["gpt-5.4", "opus-5-5", "Claude-opus-5-5", "claude-model bad", "claude-model*"])("does not synthesize aliases for %s", id => {
		expect(aliases(parse([{ ...raw, id: `claude1/${id}` }]))).toEqual([]);
	});

	it("keeps input models unchanged and ignores entries that did not produce a usable model", () => {
		const [base] = single();
		const plain = { ...base };
		delete plain.magpieRoute;
		const models = addMagpieModelAliases([plain], [null, { ...raw, id: `claude1/${name}` }, { ...raw, id: `claude2/${name}` }]);
		expect(models).toHaveLength(2);
		expect(plain).not.toHaveProperty("magpieRoute");
	});
});

describe("local alias resolution and dispatch guards", () => {
	it("clones only local aliases and retains all metadata while resolving the physical ID", () => {
		const models = single();
		const alias = aliasOf(models);
		expect(resolveMagpieAlias(models[0])).toBe(models[0]);
		expect(resolveMagpieAlias(alias)).toEqual({ ...alias, id: `claude1/${name}` });
		expect(resolveMagpieAlias(alias)).not.toBe(alias);
		expect(alias.id).toBe(name);
		expect(() => assertMagpieAliasRoute(alias, models, [])).not.toThrow();
	});

	it("distinguishes unavailable catalogs, missing targets, conflicting metadata, and competing sources", () => {
		const models = single();
		const alias = aliasOf(models);
		const cases: [MagpieAliasFailure, MagpieModel[], RegExp][] = [
			["catalog_unavailable", [], /catalog is unavailable.*\/magpie-refresh/],
			["target_missing", [alias], /target is missing.*\/magpie-refresh/],
			["metadata_conflict", parse([{ ...raw, owned_by: "claude2", id: `claude1/${name}` }]), /metadata conflicts.*reselect/],
			["metadata_conflict", [{ ...models[0], magpieRoute: { ...models[0].magpieRoute!, group: true } }], /metadata conflicts.*reselect/],
			["metadata_conflict", [{ ...models[0], magpieRoute: undefined }], /metadata conflicts.*reselect/],
			["ambiguous", parse([{ ...raw, id: `claude1/${name}` }, { ...raw, owned_by: "claude2", id: `claude2/${name}` }]), /competing sources.*explicit provider route/],
		];
		for (const [code, next, advice] of cases) {
			let failure: unknown;
			try { assertMagpieAliasRoute(alias, next, []); } catch (error) { failure = error; }
			expect(failure).toBeInstanceOf(MagpieAliasRouteError);
			expect(failure).toMatchObject({ code, message: expect.stringMatching(advice) });
		}
		const invalid: MagpieModel = { ...alias, magpieRoute: undefined };
		expect(() => assertMagpieAliasRoute(invalid, models, [])).toThrow(/metadata conflicts/);
	});

	it("rejects silent rebinding after reload by inspecting the last matching Magpie assistant", () => {
		const models = single();
		const alias = aliasOf(models);
		const message = (provider: string, model: string) => ({ role: "assistant", provider, model });
		expect(() => assertMagpieAliasRoute(alias, models, [message("magpie", `claude2/${name}`), message("magpie", "gpt-5.4")])).toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...message("magpie", name), magpiePhysicalModel: `claude2/${name}` }])).toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...message("magpie", name), magpiePhysicalModel: `claude1/${name}` }])).not.toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [message("magpie", `claude2/${name}`), message("magpie", `claude1/${name}`)])).not.toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [null, { role: "user", model: `claude2/${name}` },
			message("anthropic", `claude2/${name}`), message("magpie", "claude-other")])).not.toThrow();
		expect(() => assertMagpieAliasRoute(models[0], [], [message("magpie", `claude2/${name}`)])).not.toThrow();
	});

	it.each(["error", "aborted"])("looks past unmarked %s entries while preserving the last known source", stopReason => {
		const models = single();
		const alias = aliasOf(models);
		const failure = { role: "assistant", provider: "magpie", model: name, stopReason };
		const failures = [failure, { ...failure, stopReason: "error" }];
		const prior = { role: "assistant", provider: "magpie", model: name, magpiePhysicalModel: `claude1/${name}`, stopReason: "toolUse" };
		expect(() => assertMagpieAliasRoute(alias, models, failures)).not.toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [prior, ...failures])).not.toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...prior, magpiePhysicalModel: `claude2/${name}` }, ...failures])).toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...prior, magpiePhysicalModel: undefined }, ...failures])).toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...failure, magpiePhysicalModel: `claude2/${name}` }])).toThrow();
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...failure, model: `claude2/${name}` }])).toThrow();
	});

	it("does not expose route values or transcript text in errors", () => {
		const models = single();
		expect(() => assertMagpieAliasRoute(aliasOf(models), models, [{ role: "assistant", provider: "magpie", model: `SECRET/${name}`, content: "SECRET" }]))
			.toThrow(/^Magpie's short model alias conflicts with the physical source recorded in this session\. Start a new session or select the explicit provider route previously used by this session\.$/);
	});
});

describe("auto group aliases", () => {
	const name = "gpt-6-astra";
	const route = { id: `auto/${name}`, native_endpoints: ["/v1/responses"], context_window: 123456, max_output_tokens: 1234 };
	it("copies only the usable auto route without requiring an owner", () => {
		const models = parse([route, { ...raw, id: `codex/${name}` }]);
		expect(aliasOf(models)).toEqual({ ...models[0], id: name, name, magpieAliasTarget: route.id });
		expect(() => assertMagpieAliasRoute(aliasOf(models), models, [])).not.toThrow();
	});
	it.each([`group/${name}`, `auto/nested/${name}`, "auto/bad*name", "auto/bad name"])("does not shorten %s", id => {
		expect(aliases(parse([{ ...route, id }]))).toEqual([]);
	});
	it("preserves advertised bare rows whether proven or conflicting", () => {
		for (const bare of [{ ...route, id: name }, { ...route, id: name, context_window: 999 }]) {
			const models = parse([route, bare]);
			expect(models).toHaveLength(2);
			expect(models[1].magpieAliasTarget).toBeUndefined();
			expect(models[1].magpieRoute?.canonicalId).toBe(bare.context_window === route.context_window ? route.id : name);
		}
	});
	it("allows changing first-member owners and additional sources but rejects missing or rebound targets", () => {
		const models = parse([route]);
		const alias = aliasOf(models);
		const next = parse([{ ...route, owned_by: "other" }, { ...raw, id: `codex/${name}` }]);
		expect(() => assertMagpieAliasRoute(alias, next, [])).not.toThrow();
		expect(() => assertMagpieAliasRoute(alias, [alias], [])).toThrow(/target is missing/);
		const rebound = parse([route, { id: name, owned_by: "codex" }, { id: `codex/${name}`, owned_by: "codex" }]);
		expect(() => assertMagpieAliasRoute(alias, rebound, [])).toThrow(/metadata conflicts/);
		for (const invalid of [
			{ ...alias, id: `nested/${name}` },
			{ ...alias, magpieRoute: { ...alias.magpieRoute!, group: false } },
			{ ...alias, magpieAliasTarget: `group/${name}` },
		]) expect(() => assertMagpieAliasRoute(invalid, models, [])).toThrow(/metadata conflicts/);
		for (const invalid of [
			{ ...models[0], magpieAliasTarget: route.id },
			{ ...models[0], magpieRoute: undefined },
			{ ...models[0], magpieRoute: { ...models[0].magpieRoute!, group: false } },
		]) expect(() => assertMagpieAliasRoute(alias, [invalid], [])).toThrow(/metadata conflicts/);
	});
	it("keeps concrete and auto transcript provenance distinct", () => {
		const models = parse([route]);
		const alias = aliasOf(models);
		const prior = { role: "assistant", provider: "magpie", model: name, magpiePhysicalModel: route.id };
		expect(() => assertMagpieAliasRoute(alias, models, [prior])).not.toThrow();
		for (const physical of [`codex/${name}`, name]) {
			expect(() => assertMagpieAliasRoute(alias, models, [{ ...prior, magpiePhysicalModel: physical }])).toThrow(/physical source/);
		}
		expect(() => assertMagpieAliasRoute(alias, models, [{ ...prior, model: `codex/${name}`, magpiePhysicalModel: undefined }])).toThrow(/physical source/);
	});
});
