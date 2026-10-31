import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

/** The sign band's version line, once the health answer is in. */
async function versionLine(): Promise<HTMLElement> {
	const band = await screen.findByRole("banner");
	await waitFor(() => expect(band.querySelector("[data-server-version]")).not.toBeNull());
	return band.querySelector<HTMLElement>("[data-server-version]")!;
}

describe("server version", () => {
	it("shows the server's version and the commit it was built from at the right of the band", async () => {
		renderApp("/", createFakeServer({ revision: "56b7f44" }).fetch);
		const line = await versionLine();
		expect(line.textContent).toBe("pika 0.3.0 (56b7f44)");
		expect(line.title).toBe("pika 0.3.0, built from commit 56b7f44");
		// It sits left of the band's buttons, in the group pushed to the band's right end, so it never moves them.
		const controls = line.parentElement!;
		expect(controls).toBe(controls.parentElement!.lastElementChild);
		expect(line.compareDocumentPosition(within(controls).getByRole("button", { name: /theme/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows only the version when the server's build recorded no commit", async () => {
		renderApp("/", createFakeServer({}).fetch);
		expect((await versionLine()).textContent).toBe("pika 0.3.0");
	});

	it("shows nothing while health is failing", async () => {
		const server = createFakeServer({ revision: "56b7f44" });
		server.state.healthFailures = 100;
		renderApp("/", server.fetch);
		const band = await screen.findByRole("banner");
		await within(band).findByRole("link", { name: "Sessions" });
		await waitFor(() => expect(server.calls.filter((call) => call.endsWith("/api/health")).length).toBeGreaterThan(0));
		expect(band.querySelector("[data-server-version]")).toBeNull();
	});
});
