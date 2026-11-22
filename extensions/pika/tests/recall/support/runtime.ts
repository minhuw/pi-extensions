import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry } from "../../../credentials.ts";
import { timing } from "../../../recall/client.ts";
import recallExtension from "../../../recall/index.ts";
import { callTool, setCredentials, startSession as startBaseSession, Workspace as BaseWorkspace, type Harness } from "../../support/runtime.ts";

export { callTool, setCredentials, type Harness };

const DEFAULT_TIMING = { ...timing };

/** A temp directory holding the agent dir, session dir, and project cwd of one test. */
export class Workspace extends BaseWorkspace {
	static override async create(): Promise<Workspace> {
		const workspace = await BaseWorkspace.create({
			prefix: "pi-recall-", project: "my-project",
			onCleanup: () => { setCredentials(undefined); delete credentialsRegistry().repository; },
		});
		Object.assign(timing, DEFAULT_TIMING);
		return workspace;
	}
}

/** A real pi session runtime with recall and the faux provider. */
export async function startSession(options: { workspace: Workspace; cwd?: string; mode?: ExtensionContext["mode"]; extensions?: ExtensionFactory[] }): Promise<Harness> {
	return startBaseSession({
		...options,
		provider: "recall-test",
		extensions: [recallExtension, ...(options.extensions ?? [])],
	});
}
