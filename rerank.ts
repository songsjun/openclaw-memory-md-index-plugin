import type { MemorySearchHit } from "./indexer.js";
import type { MemoryDocument, MemoryDocumentMetadata } from "./store.js";

type RerankDetail = {
  relativePath: string;
  lexical: number;
  recency: number;
  usage: number;
  confidence: number;
  final: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeLexicalScores(hits: MemorySearchHit[]): Map<string, number> {
  const maxScore = hits.reduce((best, hit) => Math.max(best, hit.score), 0);
  const normalized = new Map<string, number>();
  for (const hit of hits) {
    if (maxScore <= 0) {
      normalized.set(hit.relativePath, 0);
      continue;
    }
    normalized.set(hit.relativePath, clamp01(hit.score / maxScore));
  }
  return normalized;
}

function calculateRecencyScore(metadata: MemoryDocumentMetadata | undefined, now: Date): number {
  const fallbackTs = now.toISOString();
  const raw = metadata?.updatedAt ?? metadata?.createdAt ?? fallbackTs;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return 0.3;
  }
  const ageDays = Math.max(0, (now.getTime() - parsed) / (24 * 60 * 60 * 1000));
  return clamp01(Math.exp(-ageDays / 30));
}

function calculateUsageScore(metadata: MemoryDocumentMetadata | undefined): number {
  const usage = Math.max(0, metadata?.usageCount ?? 0);
  const success = Math.max(0, metadata?.successCount ?? 0);
  const fail = Math.max(0, metadata?.failCount ?? 0);
  const net = usage + success * 2 - fail;
  return clamp01(net / 20);
}

function calculateConfidence(metadata: MemoryDocumentMetadata | undefined): number {
  return clamp01(metadata?.confidence ?? 0.5);
}

export function rerankMemoryHits(params: {
  hits: MemorySearchHit[];
  docs: MemoryDocument[];
  now?: Date;
}): {
  hits: MemorySearchHit[];
  details: RerankDetail[];
} {
  if (params.hits.length <= 1) {
    return {
      hits: params.hits,
      details: params.hits.map((hit) => ({
        relativePath: hit.relativePath,
        lexical: 1,
        recency: 0,
        usage: 0,
        confidence: 0,
        final: hit.score,
      })),
    };
  }

  const now = params.now ?? new Date();
  const lexicalMap = normalizeLexicalScores(params.hits);
  const docsByRelativePath = new Map<string, MemoryDocument>();
  for (const doc of params.docs) {
    docsByRelativePath.set(doc.relativePath, doc);
  }

  const details = params.hits.map((hit) => {
    const metadata = docsByRelativePath.get(hit.relativePath)?.metadata;
    const lexical = lexicalMap.get(hit.relativePath) ?? 0;
    const recency = calculateRecencyScore(metadata, now);
    const usage = calculateUsageScore(metadata);
    const confidence = calculateConfidence(metadata);
    const final = 0.65 * lexical + 0.15 * recency + 0.1 * usage + 0.1 * confidence;
    return {
      relativePath: hit.relativePath,
      lexical,
      recency,
      usage,
      confidence,
      final,
    };
  });

  const detailByPath = new Map(details.map((detail) => [detail.relativePath, detail]));
  const rerankedHits = [...params.hits]
    .sort((a, b) => {
      const aScore = detailByPath.get(a.relativePath)?.final ?? a.score;
      const bScore = detailByPath.get(b.relativePath)?.final ?? b.score;
      if (bScore === aScore) {
        return a.relativePath.localeCompare(b.relativePath);
      }
      return bScore - aScore;
    })
    .map((hit) => ({
      ...hit,
      score: detailByPath.get(hit.relativePath)?.final ?? hit.score,
    }));

  return {
    hits: rerankedHits,
    details: details.sort((a, b) => b.final - a.final),
  };
}
