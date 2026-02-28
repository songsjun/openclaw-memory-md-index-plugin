import type { MemoryDocument } from "./store.js";

const DOMAIN_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  programming: [
    "code",
    "coding",
    "bug",
    "plugin",
    "hook",
    "test",
    "typescript",
    "javascript",
    "node",
    "api",
    "compile",
    "build",
  ],
  ops: [
    "deploy",
    "deployment",
    "gateway",
    "service",
    "docker",
    "kubernetes",
    "ssh",
    "linux",
    "restart",
    "log",
    "infra",
  ],
  product: ["feature", "requirement", "roadmap", "workflow", "acceptance", "spec", "ux"],
  people: ["team", "owner", "stakeholder", "customer", "contact", "person"],
};

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((token) => token.length > 1);
}

function domainFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("mid/")) {
    return "general";
  }
  const segments = normalized.split("/");
  return segments[1] && segments[1] !== "." ? segments[1] : "general";
}

function getDocumentDomain(doc: MemoryDocument): string {
  return doc.metadata?.domain?.trim() || domainFromRelativePath(doc.relativePath);
}

function hasIntersection(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const bSet = new Set(b.map((item) => item.toLowerCase()));
  return a.some((item) => bSet.has(item.toLowerCase()));
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = tag.toLowerCase().trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export type MemoryRoutingHints = {
  domain: string;
  allowTags: string[];
  denyTags: string[];
  reason: string;
  queryTokens: string[];
};

export function inferRoutingHints(params: {
  query: string;
  denyTags?: string[];
}): MemoryRoutingHints {
  const queryTokens = tokenize(params.query);
  let domain = "general";
  let bestScore = 0;

  for (const [candidateDomain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (queryTokens.includes(keyword)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      domain = candidateDomain;
    }
  }

  const allowTags = normalizeTags(
    domain === "general"
      ? []
      : queryTokens.filter((token) => DOMAIN_KEYWORDS[domain]?.includes(token)),
  );
  return {
    domain,
    allowTags,
    denyTags: normalizeTags(params.denyTags ?? []),
    reason: bestScore > 0 ? `keyword_match:${bestScore}` : "fallback:general",
    queryTokens,
  };
}

export function filterDocumentsForRouting(params: {
  docs: MemoryDocument[];
  hints: MemoryRoutingHints;
  fallbackCrossDomainDocs: number;
}): {
  filteredDocs: MemoryDocument[];
  rejectedCount: number;
  fallbackCount: number;
} {
  const denied = params.hints.denyTags;
  const allowedDocs = params.docs.filter((doc) => {
    const denyTags = doc.metadata?.denyTags ?? [];
    return !hasIntersection(denyTags, denied);
  });

  if (params.hints.domain === "general") {
    return {
      filteredDocs: allowedDocs,
      rejectedCount: params.docs.length - allowedDocs.length,
      fallbackCount: 0,
    };
  }

  const matched: MemoryDocument[] = [];
  const overflow: MemoryDocument[] = [];
  for (const doc of allowedDocs) {
    const rel = doc.relativePath.replace(/\\/g, "/");
    const alwaysInclude = rel.startsWith("short/") || rel.startsWith("long/");
    const docDomain = getDocumentDomain(doc);
    if (alwaysInclude || docDomain === params.hints.domain) {
      matched.push(doc);
      continue;
    }
    overflow.push(doc);
  }

  const fallbackCount = Math.max(0, params.fallbackCrossDomainDocs);
  const fallbackDocs = overflow
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .slice(0, fallbackCount);
  return {
    filteredDocs: [...matched, ...fallbackDocs],
    rejectedCount: params.docs.length - matched.length - fallbackDocs.length,
    fallbackCount: fallbackDocs.length,
  };
}
