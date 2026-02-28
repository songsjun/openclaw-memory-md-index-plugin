import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMemoryMdIndexConfig } from "./config.js";
import { appendUsageEvent } from "./lifecycle.js";
import { runMemoryMaintenance } from "./maintenance.js";
import { MarkdownMemoryStore } from "./store.js";

describe("runMemoryMaintenance", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-maintain-"));
  });

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("archives stale session state, dedupes mid entries and writes daily report", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });
    await store.ensureLayout();

    const sessionStatePath = path.join(workspaceDir, "memory/short/session_state.md");
    await fs.writeFile(sessionStatePath, "# Session State\nold\n", "utf8");
    await fs.utimes(
      sessionStatePath,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );

    const midDir = path.join(workspaceDir, "memory/mid/programming");
    await fs.mkdir(midDir, { recursive: true });
    const midPath = path.join(midDir, "2026-02-24.md");
    const duplicated = [
      "## [2026-02-24T10:00:00.000Z] Session Summary",
      "",
      "---",
      'id: "mem_20260224_1"',
      'title: "Session Summary"',
      'domain: "programming"',
      "tags: []",
      "deny_tags: []",
      'created_at: "2026-02-24T10:00:00.000Z"',
      'updated_at: "2026-02-24T10:00:00.000Z"',
      "source:",
      '  type: "session"',
      '  ref: "s1"',
      "confidence: 0.75",
      "usage_count: 0",
      "success_count: 0",
      "fail_count: 0",
      "last_used_at: null",
      "ttl_days: 30",
      'layer: "L1"',
      "category: session",
      "---",
      "",
      "task: A",
      "",
      "sources:",
      "- session:s1",
      "",
      "## [2026-02-24T10:00:00.000Z] Session Summary",
      "",
      "---",
      'id: "mem_20260224_1"',
      'title: "Session Summary"',
      'domain: "programming"',
      "tags: []",
      "deny_tags: []",
      'created_at: "2026-02-24T10:00:00.000Z"',
      'updated_at: "2026-02-24T10:00:00.000Z"',
      "source:",
      '  type: "session"',
      '  ref: "s1"',
      "confidence: 0.75",
      "usage_count: 0",
      "success_count: 0",
      "fail_count: 0",
      "last_used_at: null",
      "ttl_days: 30",
      'layer: "L1"',
      "category: session",
      "---",
      "",
      "task: A",
      "",
      "sources:",
      "- session:s1",
      "",
    ].join("\n");
    await fs.writeFile(midPath, duplicated, "utf8");

    await appendUsageEvent({
      rootDir: path.join(workspaceDir, "memory"),
      event: {
        ts: "2026-02-24T11:00:00.000Z",
        type: "prompt_injected",
        relativePath: "mid/programming/2026-02-24.md",
      },
    });
    await appendUsageEvent({
      rootDir: path.join(workspaceDir, "memory"),
      event: {
        ts: "2026-02-24T11:00:01.000Z",
        type: "task_outcome",
        relativePath: "mid/programming/2026-02-24.md",
        success: true,
      },
    });

    const result = await runMemoryMaintenance({
      store,
      mode: "daily",
      config: {
        ...cfg,
        maintenance: {
          ...cfg.maintenance,
          enabled: true,
          archiveAfterDays: 3,
          dedupe: true,
        },
      },
      now: () => new Date("2026-02-24T12:00:00.000Z"),
    });

    expect(result.mode).toBe("daily");
    expect(result.archivedSessionState).toBe(true);
    expect(result.dedupedFiles).toBe(1);
    expect(result.removedDuplicateBlocks).toBe(1);
    expect(result.dailyReportPath).toContain("/memory/reports/daily_2026-02-24.md");
    expect(result.weeklyReportPath).toBeUndefined();

    const dailyReport = await fs.readFile(result.dailyReportPath, "utf8");
    expect(dailyReport).toContain("promote_candidates:");

    await expect(fs.stat(sessionStatePath)).rejects.toThrow();
    const archiveDirEntries = await fs.readdir(path.join(workspaceDir, "memory/archive"));
    expect(archiveDirEntries.some((name) => name.startsWith("session_state_"))).toBe(true);

    const dedupedMid = await fs.readFile(midPath, "utf8");
    const headerMatches = dedupedMid.match(/## \[/g) ?? [];
    expect(headerMatches.length).toBe(1);
  });

  it("runs weekly consolidation and emits conflict report", async () => {
    const cfg = getDefaultMemoryMdIndexConfig();
    const store = new MarkdownMemoryStore({
      workspaceDir,
      rootDir: cfg.rootDir,
      sessionStateFile: cfg.writeback.sessionStateFile,
      midDir: cfg.writeback.midDir,
    });
    await store.ensureLayout();

    await fs.writeFile(
      path.join(workspaceDir, "memory/proposals/rules_2026-02-24.md"),
      [
        "# Rule Candidates",
        "",
        "candidate_rules:",
        "- Always run tests before merge.",
        "- Never run tests before merge.",
        "- Enable strict quality gate by default.",
        "- Disable strict quality gate by default.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runMemoryMaintenance({
      store,
      mode: "weekly",
      config: {
        ...cfg,
        maintenance: {
          ...cfg.maintenance,
          enabled: true,
          weeklyEnabled: true,
          weeklyWeekday: 1,
        },
      },
      now: () => new Date("2026-02-23T08:00:00.000Z"),
    });

    expect(result.mode).toBe("weekly");
    expect(result.weeklyConsolidatedRules).toBeGreaterThanOrEqual(4);
    expect(result.weeklyConflictPairs).toBeGreaterThanOrEqual(2);
    expect(result.weeklyReportPath).toContain("/memory/reports/weekly_2026-02-23.md");
    expect(result.weeklyProposalPath).toContain(
      "/memory/proposals/rules_consolidated_2026-02-23.md",
    );

    const weeklyReport = await fs.readFile(result.weeklyReportPath as string, "utf8");
    expect(weeklyReport).toContain("conflict_pairs:");
    expect(weeklyReport).toContain("always_vs_never");

    const consolidated = await fs.readFile(result.weeklyProposalPath as string, "utf8");
    expect(consolidated).toContain("## Consolidated Rules");
    expect(consolidated).toContain("Always run tests before merge.");
  });
});
