import { describe, expect, it } from "vitest";
import type { MemorySearchHit } from "./indexer.js";
import { rerankMemoryHits } from "./rerank.js";
import type { MemoryDocument } from "./store.js";

function createDoc(params: {
  relativePath: string;
  updatedAt: string;
  confidence: number;
  usageCount?: number;
  layer?: "L0" | "L1" | "L2";
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
      usageCount: params.usageCount ?? 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
      ttlDays: 30,
      layer: params.layer ?? "L1",
    },
  };
}

describe("rerankMemoryHits", () => {
  it("promotes recent/high-confidence docs when lexical scores tie", () => {
    const hits: MemorySearchHit[] = [
      {
        relativePath: "mid/programming/old.md",
        snippet: "old",
        score: 1,
      },
      {
        relativePath: "mid/programming/new.md",
        snippet: "new",
        score: 1,
      },
    ];
    const docs: MemoryDocument[] = [
      createDoc({
        relativePath: "mid/programming/old.md",
        updatedAt: "2025-12-01T00:00:00.000Z",
        confidence: 0.4,
      }),
      createDoc({
        relativePath: "mid/programming/new.md",
        updatedAt: "2026-02-26T00:00:00.000Z",
        confidence: 0.9,
        usageCount: 8,
      }),
    ];

    const reranked = rerankMemoryHits({
      hits,
      docs,
      now: new Date("2026-02-27T00:00:00.000Z"),
    });
    expect(reranked.hits[0]?.relativePath).toBe("mid/programming/new.md");
    expect(reranked.hits[0]?.score).toBeGreaterThan(reranked.hits[1]?.score ?? 0);
  });

  it("L2 layer documents get recency score 1.0 regardless of age", () => {
    const hits: MemorySearchHit[] = [
      { relativePath: "long/rules.md", snippet: "always use strict mode", score: 1 },
      { relativePath: "mid/programming/recent.md", snippet: "enabled strict mode today", score: 1 },
    ];
    const docs: MemoryDocument[] = [
      createDoc({
        relativePath: "long/rules.md",
        updatedAt: "2025-06-01T00:00:00.000Z", // ~270 days old
        confidence: 0.7,
        layer: "L2",
      }),
      createDoc({
        relativePath: "mid/programming/recent.md",
        updatedAt: "2026-02-26T00:00:00.000Z", // 1 day old
        confidence: 0.7,
        layer: "L1",
      }),
    ];

    const reranked = rerankMemoryHits({
      hits,
      docs,
      now: new Date("2026-02-27T00:00:00.000Z"),
    });

    const l2Detail = reranked.details.find((d) => d.relativePath === "long/rules.md");
    const l1Detail = reranked.details.find((d) => d.relativePath === "mid/programming/recent.md");

    // L2 recency must be 1.0 (no decay)
    expect(l2Detail?.recency).toBe(1.0);
    // L1 recency should decay normally (1 day old → ~0.967)
    expect(l1Detail?.recency).toBeLessThan(1.0);
    expect(l1Detail?.recency).toBeGreaterThan(0.9);
  });

  it("L2 immunity prevents old rules from being buried by recent entries", () => {
    // Equal lexical scores — the difference comes from recency + confidence
    const hits: MemorySearchHit[] = [
      { relativePath: "long/old-rules.md", snippet: "rule content", score: 1.0 },
      { relativePath: "mid/programming/new.md", snippet: "new content", score: 1.0 },
    ];
    const docs: MemoryDocument[] = [
      createDoc({
        relativePath: "long/old-rules.md",
        updatedAt: "2025-01-01T00:00:00.000Z", // 1+ year old
        confidence: 0.9,
        layer: "L2",
      }),
      createDoc({
        relativePath: "mid/programming/new.md",
        updatedAt: "2026-02-26T00:00:00.000Z", // 1 day old
        confidence: 0.5,
        layer: "L1",
      }),
    ];

    const reranked = rerankMemoryHits({
      hits,
      docs,
      now: new Date("2026-02-27T00:00:00.000Z"),
    });

    // L2: 0.65*1.0 + 0.15*1.0 + 0.1*0 + 0.1*0.9 = 0.89
    // L1: 0.65*1.0 + 0.15*0.967 + 0.1*0 + 0.1*0.5 = 0.845
    // L2 wins with equal lexical scores due to recency immunity + higher confidence
    expect(reranked.hits[0]?.relativePath).toBe("long/old-rules.md");
  });

  it("keeps stable ordering when metadata is missing", () => {
    const hits: MemorySearchHit[] = [
      {
        relativePath: "mid/a.md",
        snippet: "A",
        score: 2,
      },
      {
        relativePath: "mid/b.md",
        snippet: "B",
        score: 1,
      },
    ];

    const reranked = rerankMemoryHits({
      hits,
      docs: [],
      now: new Date("2026-02-27T00:00:00.000Z"),
    });
    expect(reranked.hits[0]?.relativePath).toBe("mid/a.md");
    expect(reranked.hits[1]?.relativePath).toBe("mid/b.md");
  });
});
