import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerMagpieFast } from "../fast.ts";
import { parseModels } from "../index.ts";

const origin = "http://127.0.0.1:3425";
const tier = [{ id: "priority", name: "Fast" }];
const catalog = () => parseModels({ data: [
	{ id: "auto/gpt-6.1-terra", service_tiers: tier },
	{ id: "codex/gpt-6.1-terra", native_endpoints: ["/v1/responses"], service_tiers: tier },
] }, origin);

function harness() {
	const models = catalog();
	const selected = models.find(model => model.id === "gpt-6.1-terra")!;
	const session = SessionManager.inMemory();
	const anchor = session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
	registerMagpieFast({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
	} as unknown as ExtensionAPI);
	const ctx = {
		model: selected,
		modelRegistry: { getAll: () => models },
		sessionManager: session,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	const command = (args: string) => commands.get("fast")!.handler(args, ctx);
	const request = (payload: unknown) => handlers.get("before_provider_request")!({ payload }, ctx);
	return { models, selected, session, anchor, ctx, command, request };
}

describe("Magpie Fast", () => {
	it("preserves advertised service tiers on concrete models, groups and aliases", () => {
		const models = catalog();
		for (const id of ["auto/gpt-6.1-terra", "gpt-6.1-terra", "codex/gpt-6.1-terra"]) {
			expect(models.find(model => model.id === id)).toMatchObject({
				api: "openai-responses", magpieServiceTiers: ["priority"],
			});
		}
		const [model] = parseModels({ data: [{ id: "other", service_tiers: ["priority", { id: "priority" }, null, { id: 5 }] }] }, origin);
		expect(model.magpieServiceTiers).toEqual(["priority"]);
	});

	it("adds priority only while enabled, preserving the rest of the request", () => {
		const h = harness();
		const payload = { model: "auto/gpt-6.1-terra", input: [{ role: "user", content: "hello" }] };
		expect(h.request(payload)).toBeUndefined();
		h.command("on");
		expect(h.request(payload)).toEqual({ ...payload, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
		h.command("off");
		expect(h.request(payload)).toBeUndefined();
	});

	it("does not enable Fast for unsupported or unavailable models", () => {
		const h = harness();
		h.models.splice(0);
		h.command("on");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("advertises priority"), "warning");
		expect(h.session.getBranch().some(entry => entry.type === "custom")).toBe(false);
	});

	it("does not change requests for a different model, API, or removed tier", () => {
		const h = harness();
		h.command("on");
		const payload = { model: "auto/gpt-6.1-terra", input: [] };
		expect(h.request({ ...payload, model: "another-model" })).toBeUndefined();
		expect(h.request(null)).toBeUndefined();
		h.ctx.model = { ...h.selected, provider: "other" };
		expect(h.request(payload)).toBeUndefined();
		h.ctx.model = { ...h.selected, api: "anthropic-messages" };
		expect(h.request(payload)).toBeUndefined();
		h.ctx.model = h.selected;
		const index = h.models.findIndex(model => model.id === h.selected.id);
		h.models[index] = { ...h.models[index], magpieServiceTiers: [] };
		expect(h.request(payload)).toBeUndefined();
	});

	it("restores the switch from the active session branch", () => {
		const h = harness();
		const payload = { model: "auto/gpt-6.1-terra", input: [] };
		h.command("on");
		const on = h.session.getLeafId()!;
		h.command("off");
		expect(h.request(payload)).toBeUndefined();
		h.session.branch(on);
		expect(h.request(payload)).toMatchObject({ service_tier: "priority" });
		h.session.branch(h.anchor);
		expect(h.request(payload)).toBeUndefined();
	});
});
