import { assert, hostError, mockHost, mount, test } from "orca/testing";
import * as panel from "../src/panel.tsx";
import { activity, empty, session } from "./fixtures.ts";

test("explains how to connect an empty session list", async () => {
	const view = await mount(panel, { host: mockHost({ requests: { "activity.list": empty } }) });
	try {
		await view.settled();
		assert.ok(view.find({ type: "EmptyState", text: /No Pi sessions yet/ }));
		assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, []);
	} finally { await view.unmount(); }
});

test("keeps background activities visible after the main agent settles, then removes completed work", async () => {
	let response = activity();
	const view = await mount(panel, { host: mockHost({ requests: { "activity.list": () => response } }) });
	try {
		await view.settled();
		assert.ok(view.find({ type: "Text", text: "reviewer · Check lifecycle cleanup" }));
		assert.ok(view.find({ type: "Text", text: "Idle" }));
		response = activity([session({ activities: [], activityCount: 0 })]);
		await view.post("activity.changed", { revision: 2 });
		await view.settled();
		assert.equal(view.find({ type: "Text", text: "reviewer · Check lifecycle cleanup" }), null);
		assert.ok(view.find({ type: "Text", text: "No background activities." }));
		assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, []);
	} finally { await view.unmount(); }
});

test("shows paused workflows and their real progress", async () => {
	const row = session({ activities: [{ source: "subagents", id: "workflow:1", label: "Review all modules", kind: "workflow", state: "waiting", startedAt: Date.now() - 60_000, progress: { completed: 3, total: 5 } }], activityCount: 1 });
	const view = await mount(panel, { host: mockHost({ requests: { "activity.list": activity([row]) } }) });
	try {
		await view.settled();
		assert.ok(view.find({ type: "Badge", text: "Waiting" }));
		assert.ok(view.find({ type: "Progress", label: "3 of 5 agents finished" }));
		assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, []);
	} finally { await view.unmount(); }
});

test("marks stale sessions disconnected and excludes their old work from the active summary", async () => {
	const view = await mount(panel, { host: mockHost({ requests: { "activity.list": activity([session({ online: false })]) } }) });
	try {
		await view.settled();
		assert.ok(view.find({ type: "Badge", text: "Disconnected" }));
		assert.ok(view.find({ type: "Text", text: "0 working · 0 waiting · 0 background activities" }));
		assert.ok(view.find({ type: "Text", text: /Connection lost/ }));
		assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, []);
	} finally { await view.unmount(); }
});

test("switches between sessions without switching Orca's workspace", async () => {
	const second = session({ paneKey: "pane-beta", sessionId: "session-beta", title: "Fix the login flow", activities: [], activityCount: 0 });
	const view = await mount(panel, { host: mockHost({ requests: { "activity.list": activity([session(), second]) } }) });
	try {
		await view.select({ label: "Session" }, "pane-beta");
		assert.ok(view.find({ type: "Heading", text: "Fix the login flow" }));
		assert.equal(view.find({ type: "Heading", text: "Review the Orca integration" }), null);
		assert.deepEqual(view.errors, []); assert.deepEqual(view.refusals, []);
	} finally { await view.unmount(); }
});

test("recovers from a failed worker request through Retry", async () => {
	let failed = true;
	const view = await mount(panel, { host: mockHost({ requests: { "activity.list": () => { if (failed) throw hostError("unavailable"); return empty; } } }) });
	try {
		await view.settled();
		assert.ok(view.find({ type: "EmptyState", text: /Activity is unavailable/ }));
		failed = false;
		await view.press({ type: "Button", text: "Retry" });
		assert.ok(view.find({ type: "EmptyState", text: /No Pi sessions yet/ }));
		assert.deepEqual(view.errors, []);
		assert.deepEqual(view.refusals, []);
	} finally { await view.unmount(); }
});
