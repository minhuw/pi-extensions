import { describe, expect, it } from "vitest";
import { parseModels } from "../index.ts";
import { addMagpieModelAliases, assertMagpieAliasRoute, resolveMagpieAlias, type MagpieModel } from "../model-aliases.ts";

const name = "claude-opus-5-5";
const raw = { owned_by: "claude1", native_endpoints: ["/v1/messages"], context_window: 100000,
	modalities: { input: ["text", "image"] }, custom_metadata: { ordered: [1, 2], flag: true } };
const parse = (data: unknown[]) => parseModels({ data }, "https://gateway.example");
const aliases = (models: MagpieModel[]) => models.filter(model => model.magpieAliasTarget !== undefined);
const single = () => parse([{ ...raw, id: `claude1/${name}` }]);
const aliasOf = (models: MagpieModel[]) => aliases(models)[0];

describe("source-aware catalog aliases", () => {
	it("keeps originals, proves a shortened clone, preserves groups, and appends a local Claude alias", () => {
		const models = parse([
			{ ...raw, id: `claude1/${name}` },
			{ ...raw, id: `claude1/nested/${name}` },
			{ ...raw, id: `auto/${name}` },
		]);
		// Two different concrete routes remain ambiguous even with the same owner and raw metadata.
		expect(aliases(models)).toEqual([]);
		const entries = [{ ...raw, id: `claude1/nested/${name}` }, { ...raw, id: `nested/${name}` }, { ...raw, id: `auto/${name}` }];
		const actual = parse(entries);
		expect(actual.map(model => model.id)).toEqual([...entries.map(row => row.id), name]);
		expect(actual[0].magpieRoute).toEqual({ canonicalId: entries[0].id, owner: "claude1", group: false });
		expect(actual[1].magpieRoute).toEqual(actual[0].magpieRoute);
		expect(actual[2].magpieRoute).toEqual({ canonicalId: entries[2].id, owner: "claude1", group: true });
		expect(actual[3]).toEqual({ ...actual[0], id: name, name, magpieAliasTarget: entries[0].id });
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
		expect(models.map(model => model.magpieRoute?.canonicalId)).toEqual([`auto/${name}`, `group/${name}`]);
		expect(aliases(models)).toEqual([]);
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

	it("rejects disappeared targets, changed owners, changed group routes, and newly ambiguous sources", () => {
		const models = single();
		const alias = aliasOf(models);
		for (const next of [[], parse([{ ...raw, owned_by: "claude2", id: `claude1/${name}` }]),
			[{ ...models[0], magpieRoute: { ...models[0].magpieRoute!, group: true } }],
			parse([{ ...raw, id: `claude1/${name}` }, { ...raw, owned_by: "claude2", id: `claude2/${name}` }]),
			[alias],
		]) expect(() => assertMagpieAliasRoute(alias, next, [])).toThrow(/Start a new session or select an explicit provider route/);
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

	it("does not expose route values or transcript text in errors", () => {
		const models = single();
		expect(() => assertMagpieAliasRoute(aliasOf(models), models, [{ role: "assistant", provider: "magpie", model: `SECRET/${name}`, content: "SECRET" }]))
			.toThrow(/^Magpie's short Claude alias no longer has the same unambiguous source\./);
		try { assertMagpieAliasRoute(aliasOf(models), [], []); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
	});
});
