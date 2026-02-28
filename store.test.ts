import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./store.js";

describe("MarkdownMemoryStore", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-md-index-"));
  });

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("creates memory layout directories", async () => {
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: "memory",
      sessionStateFile: "short/session_state.md",
    });

    await store.ensureLayout();
    const layout = store.getLayout();

    await expect(fs.stat(layout.shortDir)).resolves.toBeDefined();
    await expect(fs.stat(layout.midDir)).resolves.toBeDefined();
    await expect(fs.stat(layout.longDir)).resolves.toBeDefined();
    await expect(fs.stat(layout.archiveDir)).resolves.toBeDefined();
    await expect(fs.stat(layout.proposalsDir)).resolves.toBeDefined();
    await expect(fs.stat(layout.reportsDir)).resolves.toBeDefined();
  });

  it("overwrites session state using stable template", async () => {
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: "memory",
      sessionStateFile: "short/session_state.md",
    });

    await store.writeSessionState({
      timestamp: "2026-02-24T10:00:00.000Z",
      task: "Implement memory plugin",
      summary: "Added writeback pipeline.",
      decisions: ["Use markdown as source of truth"],
      todos: ["Add scheduler"],
      sources: ["session:abc"],
    });

    const content = await fs.readFile(
      path.join(workspaceDir, "memory/short/session_state.md"),
      "utf8",
    );
    expect(content).toContain("# Session State");
    expect(content).toContain("task: Implement memory plugin");
    expect(content).toContain("- Use markdown as source of truth");
    expect(content).toContain("- Add scheduler");
  });

  it("appends mid entries and lists markdown docs with filters", async () => {
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: "memory",
      sessionStateFile: "short/session_state.md",
    });

    await store.appendMidEntry({
      timestamp: "2026-02-24T10:00:00.000Z",
      category: "project",
      title: "Decision: use plugin hooks",
      content: "Prefer before_prompt_build + agent_end.",
      sources: ["session:s1"],
      domain: "programming",
      tags: ["hooks", "plugin"],
    });
    await store.appendMidEntry({
      timestamp: "2026-02-24T11:00:00.000Z",
      category: "project",
      title: "Decision: keep skills untouched",
      content: "Only emit proposals.",
      sources: ["session:s2"],
      domain: "programming",
    });

    const midFile = path.join(workspaceDir, "memory/mid/programming/2026-02-24.md");
    const appended = await fs.readFile(midFile, "utf8");
    expect(appended).toContain("Decision: use plugin hooks");
    expect(appended).toContain("Decision: keep skills untouched");
    expect(appended).toContain('domain: "programming"');
    expect(appended).toContain('tags: ["hooks","plugin"]');

    await fs.mkdir(path.join(workspaceDir, "memory/archive"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory/archive/old.md"), "old", "utf8");

    const docs = await store.listDocuments({
      includePaths: ["mid", "archive"],
      excludePaths: ["archive"],
    });
    expect(docs.length).toBe(1);
    expect(docs[0]?.relativePath).toBe("mid/programming/2026-02-24.md");
    expect(docs[0]?.metadata.domain).toBe("programming");
    expect(docs[0]?.metadata.tags).toEqual(["hooks", "plugin"]);
  });

  it("reads legacy markdown entries without frontmatter using defaults", async () => {
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: "memory",
      sessionStateFile: "short/session_state.md",
    });
    await fs.mkdir(path.join(workspaceDir, "memory/mid/legacy"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory/mid/legacy/2026-02-24.md"),
      "## [2026-02-24T10:00:00.000Z] Legacy Entry\n\ncategory: session\n\ncontent",
      "utf8",
    );

    const docs = await store.listDocuments({
      includePaths: ["mid"],
    });
    expect(docs.length).toBe(1);
    expect(docs[0]?.metadata.id).toBe("legacy_2026-02-24");
    expect(docs[0]?.metadata.domain).toBe("legacy");
    expect(docs[0]?.metadata.source.type).toBe("legacy");
    expect(docs[0]?.metadata.tags).toEqual([]);
  });

  it("appends proposals into memory/proposals for manual review", async () => {
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: "memory",
      sessionStateFile: "short/session_state.md",
    });
    const proposalPath = await store.appendProposal({
      timestamp: "2026-02-24T12:00:00.000Z",
      title: "Rule Candidates",
      kind: "rules",
      content: "candidate_rules:\n- Always run tests before merge.",
      sources: ["session:s1"],
    });

    const content = await fs.readFile(proposalPath, "utf8");
    expect(proposalPath).toContain("memory/proposals/rules_2026-02-24.md");
    expect(content).toContain("Rule Candidates");
    expect(content).toContain("Always run tests before merge.");
  });
});
