import { describe, expect, it } from "vitest";
import type { MemorySearchHit } from "./indexer.js";
import { rerankMemoryHits } from "./rerank.js";
import type { MemoryDocument } from "./store.js";

function createDoc(params: {
  relativePath: string;
  updatedAt: string;
  confidence: number;
  usageCount?: number;
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
      layer: "L1",
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
