import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultMemoryMdIndexConfig } from "./config.js";
import {
  appendLifecycleDecisions,
  appendUsageEvent,
  evaluateLifecycleDecisions,
  readUsageEvents,
} from "./lifecycle.js";
import type { MemoryDocument } from "./store.js";

function createDoc(params: {
  relativePath: string;
  updatedAt: string;
  confidence: number;
}): MemoryDocument {
  return {
    absolutePath: `/tmp/memory/${params.relativePath}`,
    relativePath: params.relativePath,
    content: "sample",
    metadata: {
      id: `id_${params.relativePath}`,
      title: params.relativePath,
      domain: "programming",
      tags: [],
      denyTags: [],
      createdAt: params.updatedAt,
      updatedAt: params.updatedAt,
      source: { type: "session", ref: "s1" },
      confidence: params.confidence,
      usageCount: 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
      ttlDays: 30,
      layer: "L1",
    },
  };
}

describe("lifecycle", () => {
  let workspaceDir = "";
  let memoryRoot = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-lifecycle-"));
    memoryRoot = path.join(workspaceDir, "memory");
  });

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("writes and reads usage events", async () => {
    await appendUsageEvent({
      rootDir: memoryRoot,
      event: {
        ts: "2026-02-27T00:00:00.000Z",
        type: "retrieve_hit",
        sessionId: "s1",
        relativePath: "mid/programming/2026-02-27.md",
      },
    });
    const events = await readUsageEvents(memoryRoot);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("retrieve_hit");
  });

  it("evaluates lifecycle decisions and appends decision logs", async () => {
    const docs: MemoryDocument[] = [
      createDoc({
        relativePath: "mid/programming/high.md",
        updatedAt: "2026-02-26T00:00:00.000Z",
        confidence: 0.9,
      }),
      createDoc({
        relativePath: "mid/programming/low.md",
        updatedAt: "2025-11-01T00:00:00.000Z",
        confidence: 0.2,
      }),
    ];

    const events = [
      {
        ts: "2026-02-26T12:00:00.000Z",
        type: "prompt_injected" as const,
        relativePath: "mid/programming/high.md",
      },
      {
        ts: "2026-02-26T12:00:00.500Z",
        type: "prompt_injected" as const,
        relativePath: "mid/programming/high.md",
      },
      {
        ts: "2026-02-26T12:00:01.000Z",
        type: "task_outcome" as const,
        relativePath: "mid/programming/high.md",
        success: true,
      },
      {
        ts: "2026-01-01T00:00:00.000Z",
        type: "task_outcome" as const,
        relativePath: "mid/programming/low.md",
        success: false,
      },
    ];
    const cfg = getDefaultMemoryMdIndexConfig();
    const decisions = evaluateLifecycleDecisions({
      docs,
      events,
      config: cfg,
      now: new Date("2026-02-27T00:00:00.000Z"),
    });
    expect(decisions.length).toBe(2);
    const high = decisions.find((item) => item.relativePath.endsWith("high.md"));
    const low = decisions.find((item) => item.relativePath.endsWith("low.md"));
    expect(high?.decision).toBe("promote_candidate");
    expect(low?.decision).toBe("archive_candidate");

    await appendLifecycleDecisions({
      rootDir: memoryRoot,
      decisions,
    });
    const lifecycleLog = await fs.readFile(path.join(memoryRoot, "meta/lifecycle.jsonl"), "utf8");
    expect(lifecycleLog).toContain("promote_candidate");
    expect(lifecycleLog).toContain("archive_candidate");
  });
});
