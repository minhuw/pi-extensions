import { afterEach, expect, it, vi } from "vitest";
import { runPrintMode } from "../test/helpers/print-mode-runner.js";

afterEach(() => { vi.unstubAllEnvs(); });

it("rejects an explicit live backend before session or credential discovery", async () => {
  vi.stubEnv("PI_E2E_LIVE", "1");
  await expect(runPrintMode({ prompt: "never sent", live: { provider: "openai", model: "gpt-5" } }))
    .rejects.toThrow("Live providers are disabled");
});

it("uses the faux provider even when ambient live mode is enabled", async () => {
  vi.stubEnv("PI_E2E_LIVE", "1");
  const run = await runPrintMode({ prompt: "offline check", respond: () => "OFFLINE_OK" });
  try {
    expect(run.parentSession.model?.provider).toBe("faux");
    expect(run.parentSession.messages.some(message => JSON.stringify(message).includes("OFFLINE_OK"))).toBe(true);
  } finally {
    await run.dispose();
  }
}, 30_000);
