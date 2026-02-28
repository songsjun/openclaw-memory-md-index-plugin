import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryMdIndexConfig } from "./config.js";
import type { MemoryDocument } from "./store.js";

export type MemoryUsageEvent = {
  ts: string;
  type: "retrieve_hit" | "prompt_injected" | "task_outcome";
  sessionId?: string;
  agentId?: string;
  query?: string;
  relativePath?: string;
  success?: boolean;
};

export type LifecycleDecision = {
  ts: string;
  relativePath: string;
  score: number;
  decision: "promote_candidate" | "keep" | "archive_candidate";
  inactiveDays: number;
  successCount: number;
  failCount: number;
  usageCount: number;
};

type UsageStats = {
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function parseDate(value: string | undefined | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureMetaDir(rootDir: string): Promise<string> {
  const metaDir = path.join(rootDir, "meta");
  await fs.mkdir(metaDir, { recursive: true });
  return metaDir;
}

function usageFile(rootDir: string): string {
  return path.join(rootDir, "meta", "usage.jsonl");
}

function lifecycleFile(rootDir: string): string {
  return path.join(rootDir, "meta", "lifecycle.jsonl");
}

export async function appendUsageEvent(params: {
  rootDir: string;
  event: MemoryUsageEvent;
}): Promise<void> {
  await ensureMetaDir(params.rootDir);
  const payload = `${JSON.stringify(params.event)}\n`;
  await fs.appendFile(usageFile(params.rootDir), payload, "utf8");
}

export async function readUsageEvents(rootDir: string): Promise<MemoryUsageEvent[]> {
  let content = "";
  try {
    content = await fs.readFile(usageFile(rootDir), "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const events: MemoryUsageEvent[] = [];
  for (const row of content.split("\n")) {
    const trimmed = row.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as MemoryUsageEvent;
      events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

function buildUsageStats(events: MemoryUsageEvent[]): Map<string, UsageStats> {
  const stats = new Map<string, UsageStats>();
  for (const event of events) {
    const relativePath = event.relativePath;
    if (!relativePath) {
      continue;
    }
    const current = stats.get(relativePath) ?? {
      usageCount: 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
    };
    if (event.type === "retrieve_hit" || event.type === "prompt_injected") {
      current.usageCount += 1;
    }
    if (event.type === "task_outcome") {
      if (event.success) {
        current.successCount += 1;
      } else {
        current.failCount += 1;
      }
    }
    if (event.ts) {
      current.lastUsedAt = event.ts;
    }
    stats.set(relativePath, current);
  }
  return stats;
}

function recencyScore(
  lastTs: number | null,
  nowTs: number,
): { score: number; inactiveDays: number } {
  if (lastTs === null) {
    return { score: 0.3, inactiveDays: 365 };
  }
  const ageDays = Math.max(0, (nowTs - lastTs) / (24 * 60 * 60 * 1000));
  return {
    score: clamp01(Math.exp(-ageDays / 30)),
    inactiveDays: ageDays,
  };
}

export function evaluateLifecycleDecisions(params: {
  docs: MemoryDocument[];
  events: MemoryUsageEvent[];
  config: MemoryMdIndexConfig;
  now?: Date;
}): LifecycleDecision[] {
  const now = params.now ?? new Date();
  const nowTs = now.getTime();
  const statsMap = buildUsageStats(params.events);
  const decisions: LifecycleDecision[] = [];

  for (const doc of params.docs) {
    const stats = statsMap.get(doc.relativePath) ?? {
      usageCount: 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
    };
    const lastUsedTs = parseDate(stats.lastUsedAt) ?? parseDate(doc.metadata?.updatedAt) ?? null;
    const recency = recencyScore(lastUsedTs, nowTs);
    const successTotal = stats.successCount + stats.failCount;
    const successRate = successTotal > 0 ? stats.successCount / successTotal : 0.5;
    const usageFreq = clamp01(stats.usageCount / 20);
    const confidence = clamp01(doc.metadata?.confidence ?? 0.5);
    const failPenalty = Math.min(0.3, stats.failCount * 0.05);
    const score = clamp01(
      0.4 * successRate + 0.25 * usageFreq + 0.2 * recency.score + 0.15 * confidence - failPenalty,
    );

    let decision: LifecycleDecision["decision"] = "keep";
    if (score >= params.config.lifecycle.promoteThreshold) {
      decision = "promote_candidate";
    } else if (
      score < params.config.lifecycle.archiveThreshold &&
      recency.inactiveDays >= params.config.lifecycle.archiveInactiveDays
    ) {
      decision = "archive_candidate";
    }

    decisions.push({
      ts: now.toISOString(),
      relativePath: doc.relativePath,
      score,
      decision,
      inactiveDays: Math.floor(recency.inactiveDays),
      successCount: stats.successCount,
      failCount: stats.failCount,
      usageCount: stats.usageCount,
    });
  }

  return decisions.sort((a, b) => b.score - a.score);
}

export async function appendLifecycleDecisions(params: {
  rootDir: string;
  decisions: LifecycleDecision[];
}): Promise<void> {
  if (params.decisions.length === 0) {
    return;
  }
  await ensureMetaDir(params.rootDir);
  const lines = params.decisions.map((decision) => `${JSON.stringify(decision)}\n`).join("");
  await fs.appendFile(lifecycleFile(params.rootDir), lines, "utf8");
}
