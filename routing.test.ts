import { describe, expect, it } from "vitest";
import { filterDocumentsForRouting, inferRoutingHints } from "./routing.js";
import type { MemoryDocument } from "./store.js";

function doc(params: {
  relativePath: string;
  content: string;
  domain?: string;
  tags?: string[];
  denyTags?: string[];
}): MemoryDocument {
  return {
    absolutePath: `/tmp/memory/${params.relativePath}`,
    relativePath: params.relativePath,
    content: params.content,
    metadata: {
      id: `id_${params.relativePath}`,
      title: params.relativePath,
      domain: params.domain ?? "general",
      tags: params.tags ?? [],
      denyTags: params.denyTags ?? [],
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:00:00.000Z",
      source: { type: "session", ref: "s1" },
      confidence: 0.6,
      usageCount: 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
      ttlDays: 30,
      layer: "L1",
    },
  };
}

describe("routing hints", () => {
  it("infers programming domain from code-oriented query", () => {
    const hints = inferRoutingHints({
      query: "fix plugin bug in node test pipeline",
      denyTags: ["do_not_recall"],
    });
    expect(hints.domain).toBe("programming");
    expect(hints.allowTags).toContain("plugin");
    expect(hints.denyTags).toEqual(["do_not_recall"]);
  });

  it("filters docs by domain with fallback and deny tags", () => {
    const hints = inferRoutingHints({
      query: "restart gateway service after deployment",
      denyTags: ["do_not_recall"],
    });

    const docs: MemoryDocument[] = [
      doc({
        relativePath: "short/session_state.md",
        content: "session level context",
        domain: "general",
      }),
      doc({
        relativePath: "mid/ops/2026-02-27.md",
        content: "gateway restart checklist",
        domain: "ops",
      }),
      doc({
        relativePath: "mid/programming/2026-02-27.md",
        content: "typescript compile issue",
        domain: "programming",
      }),
      doc({
        relativePath: "mid/ops/2026-02-26.md",
        content: "sensitive key",
        domain: "ops",
        denyTags: ["do_not_recall"],
      }),
    ];

    const filtered = filterDocumentsForRouting({
      docs,
      hints,
      fallbackCrossDomainDocs: 1,
    });

    const relPaths = filtered.filteredDocs.map((item) => item.relativePath);
    expect(relPaths).toContain("short/session_state.md");
    expect(relPaths).toContain("mid/ops/2026-02-27.md");
    expect(relPaths).toContain("mid/programming/2026-02-27.md");
    expect(relPaths).not.toContain("mid/ops/2026-02-26.md");
    expect(filtered.fallbackCount).toBe(1);
    expect(filtered.rejectedCount).toBe(1);
  });
});
