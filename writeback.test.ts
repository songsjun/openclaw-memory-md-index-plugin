import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMemoryMdIndexConfig } from "./config.js";
import { MarkdownMemoryStore } from "./store.js";
import { __test_only__, writeRunMemory } from "./writeback.js";

async function findSingleMidFile(workspaceDir: string): Promise<string> {
  const midRoot = path.join(workspaceDir, "memory/mid");
  const domains = await fs.readdir(midRoot, { withFileTypes: true });
  const domainDir = domains.find((entry) => entry.isDirectory());
  if (!domainDir) {
    throw new Error("No domain subdirectory created under memory/mid");
  }
  const files = await fs.readdir(path.join(midRoot, domainDir.name));
  const mdFile = files.find((file) => file.endsWith(".md"));
  if (!mdFile) {
    throw new Error("No mid markdown file found");
  }
  return path.join(midRoot, domainDir.name, mdFile);
}

describe("writeRunMemory", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-writeback-"));
  });

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("writes session state and mid entry from agent_end event", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });

    const result = await writeRunMemory({
      store,
      config: cfg,
      event: {
        success: true,
        messages: [
          { role: "user", content: "Please summarize how to add memory hooks." },
          {
            role: "assistant",
            content: "Decision: Use before_prompt_build. TODO: Add scheduler.",
          },
        ],
      },
      ctx: { agentId: "main", sessionId: "session-1" },
      now: () => new Date("2026-02-24T12:00:00.000Z"),
    });

    expect(result.wrote).toBe(true);
    const sessionState = await fs.readFile(
      path.join(workspaceDir, "memory/short/session_state.md"),
      "utf8",
    );
    expect(sessionState).toContain("task: Please summarize how to add memory hooks.");
    expect(sessionState).toContain("Decision: Use before_prompt_build.");
    expect(sessionState).toContain("TODO: Add scheduler.");

    const midPath = await findSingleMidFile(workspaceDir);
    const mid = await fs.readFile(midPath, "utf8");
    expect(mid).toContain("Session Summary");
    expect(mid).toContain("summary: Decision: Use before_prompt_build. TODO: Add scheduler.");
    expect(mid).toContain('domain: "programming"');
    expect(mid).toContain("confidence: 0.75");
  });

  it("stores compact summary instead of full long assistant text", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });

    const longBody = [
      "[[reply_to_current]]",
      "```ts",
      "const noisy = true;",
      "```",
      "Decision: Keep memory as markdown source of truth.",
      "TODO: Add quality filter to writeback.",
      "Fact: Current backend is rg.",
      "Extra narrative ".repeat(80),
    ].join("\n");

    await writeRunMemory({
      store,
      config: cfg,
      event: {
        success: true,
        messages: [
          { role: "user", content: "give me plan" },
          { role: "assistant", content: longBody },
        ],
      },
      ctx: { sessionId: "session-long" },
      now: () => new Date("2026-02-24T13:00:00.000Z"),
    });

    const sessionState = await fs.readFile(
      path.join(workspaceDir, "memory/short/session_state.md"),
      "utf8",
    );
    expect(sessionState).toContain("Decision: Keep memory as markdown source of truth.");
    expect(sessionState).toContain("TODO: Add quality filter to writeback.");
    expect(sessionState).toContain("Fact: Current backend is rg.");
    expect(sessionState).not.toContain("const noisy = true");
    expect(sessionState).not.toContain(
      "Extra narrative Extra narrative Extra narrative Extra narrative",
    );
  });

  it("writes rule candidates into proposals when enabled", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });

    await writeRunMemory({
      store,
      config: cfg,
      event: {
        success: true,
        messages: [
          { role: "user", content: "Please record a reusable rule." },
          { role: "assistant", content: "Rule: Always run tests before merge." },
        ],
      },
      ctx: { sessionId: "session-rule" },
      now: () => new Date("2026-02-24T13:30:00.000Z"),
    });

    const proposal = await fs.readFile(
      path.join(workspaceDir, "memory/proposals/rules_2026-02-24.md"),
      "utf8",
    );
    expect(proposal).toContain("Rule Candidates");
    expect(proposal).toContain("Always run tests before merge.");
  });

  it("skips mid write when strict quality gate rejects summary", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });

    await writeRunMemory({
      store,
      config: {
        ...cfg,
        writeback: {
          ...cfg.writeback,
          qualityGate: "strict",
        },
      },
      event: {
        success: true,
        messages: [
          { role: "user", content: "short" },
          { role: "assistant", content: "ok" },
        ],
      },
      ctx: { sessionId: "session-strict" },
      now: () => new Date("2026-02-24T14:00:00.000Z"),
    });

    const midRoot = path.join(workspaceDir, "memory/mid");
    const midEntries = await fs.readdir(midRoot, { withFileTypes: true });
    expect(midEntries.length).toBe(0);
    const sessionState = await fs.readFile(
      path.join(workspaceDir, "memory/short/session_state.md"),
      "utf8",
    );
    expect(sessionState).toContain("task: short");
  });

  it("skips writeback when disabled", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });

    const result = await writeRunMemory({
      store,
      config: {
        ...cfg,
        writeback: {
          ...cfg.writeback,
          enabled: false,
        },
      },
      event: {
        success: true,
        messages: [{ role: "user", content: "test" }],
      },
      ctx: { sessionId: "session-1" },
    });

    expect(result).toEqual({ wrote: false, reason: "writeback disabled" });
    await expect(
      fs.stat(path.join(workspaceDir, "memory/short/session_state.md")),
    ).rejects.toThrow();
  });
});

describe("writeback helpers", () => {
  it("extracts text blocks from structured content", () => {
    const text = __test_only__.extractTextFromContent([
      { type: "text", text: "line 1" },
      { type: "image", data: "abc" },
      { type: "text", text: "line 2" },
    ]);
    expect(text).toBe("line 1\nline 2");
  });

  it("extracts structured rules and builds compact summary", () => {
    const text = [
      "Decision: Keep plugin-only integration.",
      "TODO: Add weekly consolidation.",
      "Fact: retrieve backend is rg.",
      "random note",
    ].join("\n");

    const rules = __test_only__.extractRules(text);
    expect(rules.decisions).toEqual(["Keep plugin-only integration."]);
    expect(rules.todos).toEqual(["Add weekly consolidation."]);
    expect(rules.facts).toEqual(["retrieve backend is rg."]);

    const summary = __test_only__.buildCompactSummary({
      assistantText: text,
      maxChars: 500,
    });
    expect(summary).toContain("Decision: Keep plugin-only integration.");
    expect(summary).toContain("TODO: Add weekly consolidation.");
    expect(summary).toContain("Fact: retrieve backend is rg.");
  });

  it("extracts rule candidates and enforces strict quality gate", () => {
    const rules = __test_only__.extractRuleCandidates(
      "Rule: Keep memory markdown-only.\nRule Candidate: Avoid direct skill edits.",
    );
    expect(rules).toEqual(["Keep memory markdown-only.", "Avoid direct skill edits."]);

    const passed = __test_only__.passesQualityGate({
      qualityGate: "strict",
      summary: "N/A",
      decisions: [],
      todos: [],
      facts: [],
      ruleCandidates: [],
    });
    expect(passed).toBe(false);
  });
});
