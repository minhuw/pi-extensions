import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir so the user-scope legacy fallback check (~/.pi/agent-memory)
// resolves against a controlled temp home rather than the developer's real
// ~/.pi state. The default return must be a valid string: pi-coding-agent
// evaluates getAgentDir() at module load, so an undefined homedir throws at import.
const mockHomedir = vi.hoisted(() => vi.fn(() => "/tmp"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: mockHomedir };
});

import { buildMemoryBlock, buildReadOnlyMemoryBlock, ensureMemoryDir, isSymlink, isUnsafeName, readMemoryIndex, resolveMemoryDir, safeReadFile } from "../src/memory.js";

describe("memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-mem-test-"));
    // Point homedir at a clean temp home with no legacy agent-memory dirs, so
    // user-scope resolution deterministically returns the agent-dir location.
    const fakeHome = join(tmpDir, "home");
    mkdirSync(fakeHome, { recursive: true });
    mockHomedir.mockReturnValue(fakeHome);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveMemoryDir", () => {
    it("resolves project scope to .pi/agent-memory/<name>", () => {
      const dir = resolveMemoryDir("auditor", "project", "/workspace");
      expect(dir).toBe("/workspace/.pi/agent-memory/auditor");
    });

    it("resolves local scope to .pi/agent-memory-local/<name>", () => {
      const dir = resolveMemoryDir("auditor", "local", "/workspace");
      expect(dir).toBe("/workspace/.pi/agent-memory-local/auditor");
    });

    it("resolves user scope under the agent dir (honors PI_CODING_AGENT_DIR)", () => {
      const originalEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(tmpDir, "custom-agent-dir");
      try {
        const dir = resolveMemoryDir("auditor", "user", "/workspace");
        expect(dir).toBe(join(tmpDir, "custom-agent-dir", "agent-memory", "auditor"));
        expect(dir).not.toContain("/workspace");
      } finally {
        if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalEnv;
      }
    });

    it("throws on names with path traversal (..)", () => {
      expect(() => resolveMemoryDir("../../etc/evil", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with forward slash", () => {
      expect(() => resolveMemoryDir("foo/bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with backslash", () => {
      expect(() => resolveMemoryDir("foo\\bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with null byte", () => {
      expect(() => resolveMemoryDir("foo\0bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on empty name", () => {
      expect(() => resolveMemoryDir("", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names starting with dot", () => {
      expect(() => resolveMemoryDir(".hidden", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with spaces", () => {
      expect(() => resolveMemoryDir("foo bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("allows hyphens, underscores, and dots in names", () => {
      expect(() => resolveMemoryDir("my-agent_v2.1", "project", "/workspace")).not.toThrow();
    });
  });

  describe("isUnsafeName (whitelist validation)", () => {
    it("rejects empty string", () => {
      expect(isUnsafeName("")).toBe(true);
    });

    it("rejects names longer than 128 chars", () => {
      expect(isUnsafeName("a".repeat(129))).toBe(true);
    });

    it("rejects path traversal", () => {
      expect(isUnsafeName("../../etc")).toBe(true);
    });

    it("rejects names starting with dot", () => {
      expect(isUnsafeName(".hidden")).toBe(true);
    });

    it("rejects names with spaces", () => {
      expect(isUnsafeName("foo bar")).toBe(true);
    });

    it("rejects names with special characters", () => {
      expect(isUnsafeName("foo;bar")).toBe(true);
      expect(isUnsafeName("foo|bar")).toBe(true);
      expect(isUnsafeName("foo`bar")).toBe(true);
    });

    it("allows valid names", () => {
      expect(isUnsafeName("my-agent")).toBe(false);
      expect(isUnsafeName("agent_v2")).toBe(false);
      expect(isUnsafeName("Agent123")).toBe(false);
      expect(isUnsafeName("my-agent.v2")).toBe(false);
    });
  });

  describe("ensureMemoryDir", () => {
    it("creates directory if it doesn't exist", () => {
      const dir = join(tmpDir, "agent-memory", "test");
      expect(existsSync(dir)).toBe(false);
      ensureMemoryDir(dir);
      expect(existsSync(dir)).toBe(true);
    });

    it("no-ops if directory already exists", () => {
      const dir = join(tmpDir, "agent-memory", "test");
      mkdirSync(dir, { recursive: true });
      ensureMemoryDir(dir); // should not throw
      expect(existsSync(dir)).toBe(true);
    });

    it("throws on symlinked directory", () => {
      const realDir = join(tmpDir, "real-dir");
      const linkDir = join(tmpDir, "symlink-dir");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, linkDir);
      expect(() => ensureMemoryDir(linkDir)).toThrow("symlinked memory directory");
    });

    it("throws on dangling leaf symlink before existsSync can short-circuit", () => {
      const missingTarget = join(tmpDir, "missing-target");
      const memDir = join(tmpDir, ".pi", "agent-memory", "dangling-agent");
      mkdirSync(join(tmpDir, ".pi", "agent-memory"), { recursive: true });
      symlinkSync(missingTarget, memDir);

      expect(existsSync(memDir)).toBe(false);
      expect(isSymlink(memDir)).toBe(true);
      expect(() => ensureMemoryDir(memDir, tmpDir)).toThrow("symlinked memory directory");
      expect(() => ensureMemoryDir(memDir)).toThrow("symlinked memory directory");
      expect(existsSync(missingTarget)).toBe(false);
    });

    it("throws when .pi ancestor directory is a symlink", () => {
      const externalDir = join(tmpDir, "external");
      mkdirSync(externalDir, { recursive: true });
      symlinkSync(externalDir, join(tmpDir, ".pi"));

      const memDir = join(tmpDir, ".pi", "agent-memory", "agent");
      expect(() => ensureMemoryDir(memDir, tmpDir)).toThrow("symlinked memory directory");
      expect(() => ensureMemoryDir(memDir)).toThrow("symlinked memory directory");
      expect(existsSync(join(externalDir, "agent-memory"))).toBe(false);
    });

    it("throws when .pi/agent-memory ancestor directory is a symlink (live or dangling)", () => {
      const externalDir = join(tmpDir, "external-mem");
      mkdirSync(externalDir, { recursive: true });
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      symlinkSync(externalDir, join(tmpDir, ".pi", "agent-memory"));

      const memDir = join(tmpDir, ".pi", "agent-memory", "agent");
      expect(() => ensureMemoryDir(memDir, tmpDir)).toThrow("symlinked memory directory");
      expect(() => ensureMemoryDir(memDir)).toThrow("symlinked memory directory");
      expect(existsSync(join(externalDir, "agent"))).toBe(false);

      // Dangling ancestor symlink (.pi/agent-memory-local)
      symlinkSync(join(tmpDir, "nonexistent-local"), join(tmpDir, ".pi", "agent-memory-local"));
      const localMemDir = join(tmpDir, ".pi", "agent-memory-local", "agent");
      expect(() => ensureMemoryDir(localMemDir, tmpDir)).toThrow("symlinked memory directory");
    });

    it("throws when agent-memory ancestor beneath agentDir is a symlink", () => {
      const agentDir = join(tmpDir, "agent-dir");
      const externalDir = join(tmpDir, "external-user-mem");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(externalDir, { recursive: true });
      symlinkSync(externalDir, join(agentDir, "agent-memory"));

      const memDir = join(agentDir, "agent-memory", "agent");
      expect(() => ensureMemoryDir(memDir, agentDir)).toThrow("symlinked memory directory");
      expect(() => ensureMemoryDir(memDir)).toThrow("symlinked memory directory");
      expect(existsSync(join(externalDir, "agent"))).toBe(false);
    });

    it("allows valid paths whose scope root sits under a symlinked parent prefix", () => {
      // Simulates OS-level symlinked prefixes above the scope root (e.g. macOS /var -> /private/var).
      const realPrefix = join(tmpDir, "private-var");
      const symlinkPrefix = join(tmpDir, "var");
      mkdirSync(join(realPrefix, "workspace"), { recursive: true });
      symlinkSync(realPrefix, symlinkPrefix);

      const workspace = join(symlinkPrefix, "workspace");
      const memDir = join(workspace, ".pi", "agent-memory", "agent");

      ensureMemoryDir(memDir, workspace);
      expect(existsSync(memDir)).toBe(true);
      // Re-running on existing dir under symlinked prefix also succeeds (with or without explicit scopeRoot).
      ensureMemoryDir(memDir, workspace);
      ensureMemoryDir(memDir);
    });
  });

  describe("isSymlink", () => {
    it("returns false for regular file", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "content");
      expect(isSymlink(file)).toBe(false);
    });

    it("returns true for symlink", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "content");
      symlinkSync(file, link);
      expect(isSymlink(link)).toBe(true);
    });

    it("returns false for nonexistent path", () => {
      expect(isSymlink(join(tmpDir, "nope"))).toBe(false);
    });
  });

  describe("safeReadFile", () => {
    it("reads regular files", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "hello");
      expect(safeReadFile(file)).toBe("hello");
    });

    it("rejects symlinked files", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "secret");
      symlinkSync(file, link);
      expect(safeReadFile(link)).toBeUndefined();
    });

    it("returns undefined for nonexistent files", () => {
      expect(safeReadFile(join(tmpDir, "nope.txt"))).toBeUndefined();
    });
  });

  describe("readMemoryIndex", () => {
    it("returns undefined when MEMORY.md doesn't exist", () => {
      const result = readMemoryIndex(tmpDir);
      expect(result).toBeUndefined();
    });

    it("reads MEMORY.md content", () => {
      writeFileSync(join(tmpDir, "MEMORY.md"), "# Memories\n- Item 1\n- Item 2");
      const result = readMemoryIndex(tmpDir);
      expect(result).toBe("# Memories\n- Item 1\n- Item 2");
    });

    it("rejects symlinked memory directory", () => {
      const realDir = join(tmpDir, "real-mem");
      const linkDir = join(tmpDir, "link-mem");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "MEMORY.md"), "# Secret");
      symlinkSync(realDir, linkDir);
      expect(readMemoryIndex(linkDir)).toBeUndefined();
    });

    it("rejects symlinked MEMORY.md file", () => {
      const realFile = join(tmpDir, "secret.md");
      writeFileSync(realFile, "# Secret");
      const memDir = join(tmpDir, "mem-dir");
      mkdirSync(memDir);
      symlinkSync(realFile, join(memDir, "MEMORY.md"));
      expect(readMemoryIndex(memDir)).toBeUndefined();
    });

    it("rejects dangling leaf symlinks (memory directory and MEMORY.md)", () => {
      const parent = join(tmpDir, ".pi", "agent-memory");
      mkdirSync(parent, { recursive: true });

      const danglingDir = join(parent, "dangling-dir-agent");
      symlinkSync(join(tmpDir, "missing-dir"), danglingDir);
      expect(existsSync(danglingDir)).toBe(false);
      expect(isSymlink(danglingDir)).toBe(true);
      expect(readMemoryIndex(danglingDir, tmpDir)).toBeUndefined();
      expect(readMemoryIndex(danglingDir)).toBeUndefined();

      const realDir = join(parent, "dangling-file-agent");
      mkdirSync(realDir, { recursive: true });
      const danglingFile = join(realDir, "MEMORY.md");
      symlinkSync(join(tmpDir, "missing-file.md"), danglingFile);
      expect(existsSync(danglingFile)).toBe(false);
      expect(isSymlink(danglingFile)).toBe(true);
      expect(readMemoryIndex(realDir, tmpDir)).toBeUndefined();
      expect(readMemoryIndex(realDir)).toBeUndefined();
    });

    it("rejects symlinked .pi ancestor directory", () => {
      const externalPi = join(tmpDir, "external-pi");
      const externalAgent = join(externalPi, "agent-memory", "agent");
      mkdirSync(externalAgent, { recursive: true });
      writeFileSync(join(externalAgent, "MEMORY.md"), "# Secret via .pi");
      symlinkSync(externalPi, join(tmpDir, ".pi"));

      const memDir = join(tmpDir, ".pi", "agent-memory", "agent");
      expect(readMemoryIndex(memDir, tmpDir)).toBeUndefined();
      expect(readMemoryIndex(memDir)).toBeUndefined();
    });

    it("rejects symlinked .pi/agent-memory ancestor directory", () => {
      const externalMem = join(tmpDir, "external-mem");
      const externalAgent = join(externalMem, "agent");
      mkdirSync(externalAgent, { recursive: true });
      writeFileSync(join(externalAgent, "MEMORY.md"), "# Secret via agent-memory");
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      symlinkSync(externalMem, join(tmpDir, ".pi", "agent-memory"));

      const memDir = join(tmpDir, ".pi", "agent-memory", "agent");
      expect(readMemoryIndex(memDir, tmpDir)).toBeUndefined();
      expect(readMemoryIndex(memDir)).toBeUndefined();
    });

    it("rejects symlinked agent-memory ancestor beneath agentDir", () => {
      const agentDir = join(tmpDir, "agent-dir");
      const externalMem = join(tmpDir, "external-user-mem");
      mkdirSync(join(externalMem, "agent"), { recursive: true });
      writeFileSync(join(externalMem, "agent", "MEMORY.md"), "# Secret user mem");
      mkdirSync(agentDir, { recursive: true });
      symlinkSync(externalMem, join(agentDir, "agent-memory"));

      const memDir = join(agentDir, "agent-memory", "agent");
      expect(readMemoryIndex(memDir, agentDir)).toBeUndefined();
      expect(readMemoryIndex(memDir)).toBeUndefined();
    });

    it("reads MEMORY.md when scope root sits under a symlinked parent prefix", () => {
      const realPrefix = join(tmpDir, "private-var");
      const symlinkPrefix = join(tmpDir, "var");
      mkdirSync(join(realPrefix, "workspace", ".pi", "agent-memory", "agent"), { recursive: true });
      writeFileSync(join(realPrefix, "workspace", ".pi", "agent-memory", "agent", "MEMORY.md"), "# Valid\n- safe");
      symlinkSync(realPrefix, symlinkPrefix);

      const workspace = join(symlinkPrefix, "workspace");
      const memDir = join(workspace, ".pi", "agent-memory", "agent");
      expect(readMemoryIndex(memDir, workspace)).toBe("# Valid\n- safe");
      expect(readMemoryIndex(memDir)).toBe("# Valid\n- safe");
    });

    it("still rejects symlinked components beneath a scope root under a symlinked parent prefix", () => {
      const realPrefix = join(tmpDir, "private-var");
      const symlinkPrefix = join(tmpDir, "var");
      const externalMem = join(tmpDir, "external-secret");
      mkdirSync(join(externalMem, "agent"), { recursive: true });
      writeFileSync(join(externalMem, "agent", "MEMORY.md"), "# Escaped");
      mkdirSync(join(realPrefix, "workspace", ".pi"), { recursive: true });
      symlinkSync(externalMem, join(realPrefix, "workspace", ".pi", "agent-memory"));
      symlinkSync(realPrefix, symlinkPrefix);

      const workspace = join(symlinkPrefix, "workspace");
      const memDir = join(workspace, ".pi", "agent-memory", "agent");
      expect(readMemoryIndex(memDir, workspace)).toBeUndefined();
      expect(() => ensureMemoryDir(memDir, workspace)).toThrow("symlinked memory directory");
    });

    it("truncates content beyond 200 lines", () => {
      const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`);
      writeFileSync(join(tmpDir, "MEMORY.md"), lines.join("\n"));
      const result = readMemoryIndex(tmpDir)!;
      expect(result).toContain("Line 200");
      expect(result).not.toContain("Line 201");
      expect(result).toContain("truncated at 200 lines");
    });
  });

  describe("buildMemoryBlock", () => {
    it("builds memory block with no existing MEMORY.md", () => {
      const block = buildMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Agent Memory");
      expect(block).toContain("agent-memory/test-agent");
      expect(block).toContain("No MEMORY.md exists yet");
      expect(block).toContain("Memory Instructions");
    });

    it("builds memory block with existing MEMORY.md", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "test-agent");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Existing\n- recall this");
      const block = buildMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Existing");
      expect(block).toContain("recall this");
      expect(block).not.toContain("No MEMORY.md exists yet");
    });

    it("creates memory directory if it doesn't exist", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "new-agent");
      expect(existsSync(memDir)).toBe(false);
      buildMemoryBlock("new-agent", "project", tmpDir);
      expect(existsSync(memDir)).toBe(true);
    });

    it("includes Read/Write/Edit instructions", () => {
      const block = buildMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Read, Write, and Edit tools");
    });

    it("uses correct directory for local scope", () => {
      const block = buildMemoryBlock("test-agent", "local", tmpDir);
      expect(block).toContain("agent-memory-local/test-agent");
    });

    it("uses correct directory for user scope", () => {
      // Pin the agent dir to a temp location so the test doesn't create
      // directories in the real home / agent dir (buildMemoryBlock mkdirs).
      const originalEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(tmpDir, "agent-dir");
      try {
        const block = buildMemoryBlock("test-agent", "user", join(tmpDir, "workspace"));
        expect(block).toContain(join(tmpDir, "agent-dir", "agent-memory", "test-agent"));
        expect(block).not.toContain(join(tmpDir, "workspace"));
      } finally {
        if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalEnv;
      }
    });

    it("includes scope label in header", () => {
      expect(buildMemoryBlock("a", "project", tmpDir)).toContain("Memory scope: project");
      expect(buildMemoryBlock("a", "local", tmpDir)).toContain("Memory scope: local");
      expect(buildMemoryBlock("a", "user", tmpDir)).toContain("Memory scope: user");
    });

    it("works when cwd or agentDir sits under a symlinked parent prefix", () => {
      const realPrefix = join(tmpDir, "private-var");
      const symlinkPrefix = join(tmpDir, "var");
      mkdirSync(join(realPrefix, "workspace"), { recursive: true });
      mkdirSync(join(realPrefix, "agent-dir"), { recursive: true });
      symlinkSync(realPrefix, symlinkPrefix);

      const workspace = join(symlinkPrefix, "workspace");
      const block = buildMemoryBlock("prefix-agent", "project", workspace);
      expect(block).toContain("No MEMORY.md exists yet");
      expect(existsSync(join(workspace, ".pi", "agent-memory", "prefix-agent"))).toBe(true);

      const originalEnv = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(symlinkPrefix, "agent-dir");
      try {
        const userBlock = buildMemoryBlock("prefix-agent", "user", workspace);
        expect(userBlock).toContain("No MEMORY.md exists yet");
        expect(existsSync(join(symlinkPrefix, "agent-dir", "agent-memory", "prefix-agent"))).toBe(true);
      } finally {
        if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalEnv;
      }
    });

    it("rejects symlinked .pi ancestor in buildMemoryBlock", () => {
      const externalPi = join(tmpDir, "external-pi");
      mkdirSync(externalPi, { recursive: true });
      symlinkSync(externalPi, join(tmpDir, ".pi"));
      expect(() => buildMemoryBlock("test-agent", "project", tmpDir)).toThrow("symlinked memory directory");
    });
  });

  describe("buildReadOnlyMemoryBlock", () => {
    it("returns read-only instructions without write/edit mention", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("read-only");
      expect(block).not.toContain("Write");
      expect(block).not.toContain("Edit");
      expect(block).not.toContain("Memory Instructions");
    });

    it("does NOT create the memory directory", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "ro-agent");
      expect(existsSync(memDir)).toBe(false);
      buildReadOnlyMemoryBlock("ro-agent", "project", tmpDir);
      expect(existsSync(memDir)).toBe(false);
    });

    it("includes existing MEMORY.md content", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "test-agent");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Existing\n- recall this");
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Existing");
      expect(block).toContain("recall this");
    });

    it("returns 'no memory available' when no MEMORY.md exists", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("No memory is available yet");
      expect(block).not.toContain("Create one");
    });

    it("includes scope label in header", () => {
      expect(buildReadOnlyMemoryBlock("a", "project", tmpDir)).toContain("Memory scope: project");
      expect(buildReadOnlyMemoryBlock("a", "local", tmpDir)).toContain("Memory scope: local");
      expect(buildReadOnlyMemoryBlock("a", "user", tmpDir)).toContain("Memory scope: user");
    });

    it("does not mention memory directory path for write access", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).not.toContain("persistent memory directory at:");
      expect(block).not.toContain("Create one at");
    });

    it("rejects symlinked memory directory in read-only mode", () => {
      const realDir = join(tmpDir, ".pi", "agent-memory", "test-agent");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "MEMORY.md"), "# Secret");
      const linkDir = join(tmpDir, ".pi", "agent-memory", "linked-agent");
      mkdirSync(join(tmpDir, ".pi", "agent-memory"), { recursive: true });
      symlinkSync(realDir, linkDir);
      // Should not read through the symlink
      const block = buildReadOnlyMemoryBlock("linked-agent", "project", tmpDir);
      expect(block).toContain("No memory is available yet");
    });

    it("rejects symlinked ancestor directory in read-only mode", () => {
      const externalMem = join(tmpDir, "external-ro");
      mkdirSync(join(externalMem, "agent"), { recursive: true });
      writeFileSync(join(externalMem, "agent", "MEMORY.md"), "# Secret");
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      symlinkSync(externalMem, join(tmpDir, ".pi", "agent-memory"));

      const block = buildReadOnlyMemoryBlock("agent", "project", tmpDir);
      expect(block).toContain("No memory is available yet");
      expect(block).not.toContain("# Secret");
    });
  });
});
