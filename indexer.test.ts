import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { MemoryMdIndexConfig } from "./config.js";
import { createMemoryIndexBackend } from "./indexer.js";
import type { MemoryDocument } from "./store.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(original.spawn),
  };
});

const baseConfig: MemoryMdIndexConfig = {
  rootDir: "memory",
  retrieve: {
    backend: "bm25",
    topK: 5,
    maxChars: 3200,
    rerank: true,
    includePaths: ["short", "mid", "long"],
    excludePaths: ["archive", "proposals"],
    rgCommand: "rg",
  },
  writeback: {
    enabled: true,
    sessionStateFile: "short/session_state.md",
    midDir: "mid",
    maxEntryChars: 1200,
    qualityGate: "basic",
    proposalsEnabled: true,
  },
  maintenance: {
    enabled: false,
    intervalMinutes: 1440,
    archiveAfterDays: 7,
    dedupe: true,
    weeklyEnabled: true,
    weeklyWeekday: 1,
  },
  lifecycle: {
    enabled: true,
    promoteThreshold: 0.75,
    archiveThreshold: 0.35,
    archiveInactiveDays: 30,
  },
  debug: false,
};

const docs: MemoryDocument[] = [
  {
    absolutePath: "/tmp/memory/short/session_state.md",
    relativePath: "short/session_state.md",
    content: "We decided to use plugin hooks for prompt injection and writeback.",
  },
  {
    absolutePath: "/tmp/memory/mid/2026-02-24.md",
    relativePath: "mid/2026-02-24.md",
    content: "User prefers concise answers and stable templates.",
  },
];

describe("memory-md-index backend", () => {
  it("bm25 returns ranked hits", async () => {
    const backend = createMemoryIndexBackend({
      config: baseConfig,
    });

    const hits = await backend.search({
      query: "prompt injection hooks",
      topK: 3,
      docs,
      memoryRootDir: "/tmp/memory",
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.relativePath).toBe("short/session_state.md");
  });

  it("rg backend falls back to bm25 when command is unavailable", async () => {
    const warn = vi.fn();
    const backend = createMemoryIndexBackend({
      config: {
        ...baseConfig,
        retrieve: {
          ...baseConfig.retrieve,
          backend: "rg",
          rgCommand: "command-that-does-not-exist-openclaw",
        },
      },
      logger: { warn },
    });

    const hits = await backend.search({
      query: "concise answers",
      topK: 3,
      docs,
      memoryRootDir: "/tmp/memory",
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rg backend passes --fixed-strings flag to prevent regex injection", async () => {
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();

    const backend = createMemoryIndexBackend({
      config: {
        ...baseConfig,
        retrieve: {
          ...baseConfig.retrieve,
          backend: "rg",
          rgCommand: "rg",
        },
      },
    });

    // Run search — may succeed or fail depending on rg availability,
    // but we only care about the args passed to spawn
    try {
      await backend.search({
        query: "config[0].name",
        topK: 3,
        docs,
        memoryRootDir: "/tmp/memory",
      });
    } catch {
      // rg may not be installed in CI — that's fine
    }

    // Verify spawn was called with --fixed-strings in the args
    expect(spawnMock).toHaveBeenCalled();
    const callArgs = spawnMock.mock.calls[0];
    const spawnArgs = callArgs?.[1] as string[];
    expect(spawnArgs).toContain("--fixed-strings");
    // Also verify query is passed as-is (literal string, not regex)
    expect(spawnArgs).toContain("config[0].name");
  });

  it("vector backend without command falls back to bm25", async () => {
    const warn = vi.fn();
    const backend = createMemoryIndexBackend({
      config: {
        ...baseConfig,
        retrieve: {
          ...baseConfig.retrieve,
          backend: "vector",
          vectorCommand: undefined,
        },
      },
      logger: { warn },
    });

    const hits = await backend.search({
      query: "stable templates",
      topK: 3,
      docs,
      memoryRootDir: "/tmp/memory",
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
