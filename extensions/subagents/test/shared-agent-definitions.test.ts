import { describe, expect, it } from "vitest";
import { parseAgentDefinition, parseAgentFrontmatter } from "../../shared/agent-definitions.js";
import { parseAgentFrontmatter as subagentsFrontmatter } from "../src/custom-agents.js";

const options = { filename: "fallback", sourcePath: "/agents/fixture.md", source: "project" as const };
describe("shared agent file parser compatibility", () => {
  it("keeps Subagents' public frontmatter parser and BOM behavior", () => {
    expect(subagentsFrontmatter).toBe(parseAgentFrontmatter);
    const { frontmatter, body } = parseAgentFrontmatter<Record<string, unknown>>("\uFEFF---\nname: Declared Name\ntools: none\n---\n prompt ");
    expect(parseAgentDefinition(frontmatter, body, options)).toMatchObject({ name: "Declared Name", builtinToolNames: [], systemPrompt: "prompt" });
  });

  it("preserves all common and standalone fields without applying Workflow runtime policy", () => {
    const config = parseAgentDefinition({
      name: " Agent ", display_name: "Label", color: "blue", description: "Description", tools: "read, ext:foo/bar",
      disallowed_tools: "write, bash", extensions: "foo, bar", exclude_extensions: "baz", skills: "research",
      model: "provider/model", thinking: "high", service_tier: " FAST ", max_turns: 3,
      persist_session: true, output_transcript: false, session_dir: "/sessions", allowed_subagents: "recon, worker",
      prompt_mode: "append", inherit_context: true, run_in_background: true, isolated: true, memory: "project", isolation: "off", enabled: false,
    }, "  system prompt \n", options);
    expect(config).toEqual({
      name: "Agent", displayName: "Label", color: "blue", description: "Description", builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"],
      disallowedTools: ["write", "bash"], extensions: ["foo", "bar"], excludeExtensions: ["baz"], skills: ["research"],
      model: "provider/model", thinking: "high", serviceTier: "fast", maxTurns: 3,
      persistSession: true, outputTranscript: false, sessionDir: "/sessions", allowedSubagents: ["recon", "worker"],
      systemPrompt: "system prompt", promptMode: "append", inheritContext: true, runInBackground: true,
      isolated: true, memory: "project", isolation: "off", enabled: false, sourcePath: options.sourcePath, source: "project",
    });
  });

  it("retains field defaults, aliases, wildcard expansion, invalid tier handling and name warnings", () => {
    const config = parseAgentDefinition({ name: " ", tools: "all", inherit_extensions: false, inherit_skills: false, service_tier: "invalid", max_turns: 0 }, "", options)!;
    expect(config).toMatchObject({ name: "fallback", extensions: false, skills: false, maxTurns: 0, enabled: true });
    expect(config.serviceTier).toBeUndefined();
    expect(config.builtinToolNames).toEqual(expect.arrayContaining(["read", "bash", "write", "edit", "grep", "find", "ls"]));
    const warnings: string[] = [];
    expect(parseAgentDefinition({ name: "plugin:agent" }, "", options, message => warnings.push(message))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('declares name "plugin:agent"');
  });
});
