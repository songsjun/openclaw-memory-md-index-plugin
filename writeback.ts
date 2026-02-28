import type { MemoryMdIndexConfig } from "./config.js";
import type { MarkdownMemoryStore } from "./store.js";

export type AgentHookContextLike = {
  agentId?: string;
  sessionId?: string;
};

export type AgentEndEventLike = {
  messages: unknown[];
  success: boolean;
  error?: string;
};

type WritebackLogger = {
  warn?: (message: string) => void;
  info?: (message: string) => void;
};

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/\[\[reply_to_current\]\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\r/g, "");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

type DomainLabel = "programming" | "ops" | "product" | "people" | "general";

const DOMAIN_KEYWORDS: Record<Exclude<DomainLabel, "general">, string[]> = {
  programming: [
    "code",
    "coding",
    "typescript",
    "javascript",
    "node",
    "test",
    "bug",
    "plugin",
    "hook",
    "memory",
    "index",
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
    "cron",
    "restart",
    "log",
  ],
  product: [
    "feature",
    "roadmap",
    "requirement",
    "workflow",
    "experience",
    "policy",
    "acceptance",
    "plan",
  ],
  people: ["team", "owner", "stakeholder", "customer", "contact", "person"],
};

function inferDomain(task: string, summary: string): DomainLabel {
  const corpus = `${task}\n${summary}`.toLowerCase();
  let bestDomain: DomainLabel = "general";
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as [
    Exclude<DomainLabel, "general">,
    string[],
  ][]) {
    let score = 0;
    for (const keyword of keywords) {
      if (corpus.includes(keyword)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return bestScore > 0 ? bestDomain : "general";
}

function inferTags(task: string, summary: string, domain: DomainLabel): string[] {
  const corpus = `${task}\n${summary}`.toLowerCase();
  const keywords = domain === "general" ? [] : DOMAIN_KEYWORDS[domain];
  const tags: string[] = [];
  for (const keyword of keywords) {
    if (!corpus.includes(keyword)) {
      continue;
    }
    if (!tags.includes(keyword)) {
      tags.push(keyword);
    }
    if (tags.length >= 6) {
      break;
    }
  }
  return tags;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const maybeText = (block as { text?: unknown; type?: unknown }).text;
    const maybeType = (block as { type?: unknown }).type;
    if ((maybeType === undefined || maybeType === "text") && typeof maybeText === "string") {
      chunks.push(maybeText);
    }
  }
  return chunks.join("\n");
}

function extractLastRoleText(messages: unknown[], role: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }
    const typed = message as { role?: unknown; content?: unknown };
    if (typed.role !== role) {
      continue;
    }
    const text = extractTextFromContent(typed.content);
    if (text.trim().length > 0) {
      return text.trim();
    }
  }
  return "";
}

function extractTaggedBullets(text: string, tags: string[]): string[] {
  const rows = text.split("\n");
  const hits: string[] = [];
  for (const row of rows) {
    const normalized = row.trim();
    if (!normalized) {
      continue;
    }
    const lower = normalized.toLowerCase();
    if (tags.some((tag) => lower.startsWith(tag))) {
      hits.push(normalized.replace(/^[-*]\s*/, ""));
    }
  }
  return hits;
}

function extractRuleCandidates(text: string): string[] {
  const normalized = stripMarkdownNoise(text);
  const rows = normalized
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
  const rules: string[] = [];

  for (const row of rows) {
    const lower = row.toLowerCase();
    if (
      lower.startsWith("rule:") ||
      lower.startsWith("rule candidate:") ||
      lower.startsWith("规则:")
    ) {
      const cleaned = row
        .replace(/^rule\s*candidate:\s*/i, "")
        .replace(/^rule:\s*/i, "")
        .replace(/^规则:\s*/i, "")
        .trim();
      if (cleaned.length > 0) {
        rules.push(cleaned);
      }
    }
  }
  return [...new Set(rules)].slice(0, 8);
}

function extractRules(text: string): {
  decisions: string[];
  todos: string[];
  facts: string[];
} {
  const normalized = stripMarkdownNoise(text);
  const rows = normalized
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);

  const decisions: string[] = [];
  const todos: string[] = [];
  const facts: string[] = [];

  for (const row of rows) {
    const lower = row.toLowerCase();
    if (
      lower.startsWith("decision:") ||
      lower.startsWith("decisions:") ||
      lower.startsWith("决定:")
    ) {
      decisions.push(row.replace(/^decision[s]?:\s*/i, "").replace(/^决定:\s*/i, ""));
      continue;
    }
    if (
      lower.startsWith("todo:") ||
      lower.startsWith("next:") ||
      lower.startsWith("action:") ||
      lower.startsWith("待办:")
    ) {
      todos.push(row.replace(/^(todo|next|action):\s*/i, "").replace(/^待办:\s*/i, ""));
      continue;
    }
    if (lower.startsWith("fact:") || lower.startsWith("facts:") || lower.startsWith("事实:")) {
      facts.push(row.replace(/^fact[s]?:\s*/i, "").replace(/^事实:\s*/i, ""));
      continue;
    }
  }

  return {
    decisions: [...new Set(decisions)].slice(0, 5),
    todos: [...new Set(todos)].slice(0, 5),
    facts: [...new Set(facts)].slice(0, 5),
  };
}

function buildCompactSummary(params: {
  assistantText: string;
  error?: string;
  maxChars: number;
}): string {
  if (params.error) {
    return truncate(`Run failed: ${params.error}`, params.maxChars);
  }

  const cleaned = squeeze(stripMarkdownNoise(params.assistantText));
  if (!cleaned) {
    return "N/A";
  }

  const extracted = extractRules(params.assistantText);
  const ruleLines = [
    ...extracted.decisions.map((item) => `Decision: ${item}`),
    ...extracted.todos.map((item) => `TODO: ${item}`),
    ...extracted.facts.map((item) => `Fact: ${item}`),
  ];
  if (ruleLines.length > 0) {
    return truncate(ruleLines.join(" | "), params.maxChars);
  }

  return truncate(cleaned, Math.min(params.maxChars, 320));
}

function isLowSignalSummary(summary: string): boolean {
  if (!summary || summary === "N/A") {
    return true;
  }
  const alphaNumeric = summary.replace(/[^a-z0-9]/gi, "");
  return alphaNumeric.length < 12;
}

function passesQualityGate(params: {
  qualityGate: "off" | "basic" | "strict";
  summary: string;
  decisions: string[];
  todos: string[];
  facts: string[];
  ruleCandidates: string[];
}): boolean {
  if (params.qualityGate === "off") {
    return true;
  }
  if (params.qualityGate === "basic") {
    return !isLowSignalSummary(params.summary);
  }
  return (
    !isLowSignalSummary(params.summary) &&
    (params.decisions.length > 0 ||
      params.todos.length > 0 ||
      params.facts.length > 0 ||
      params.ruleCandidates.length > 0 ||
      params.summary.length >= 60)
  );
}

export async function writeRunMemory(params: {
  store: MarkdownMemoryStore;
  config: MemoryMdIndexConfig;
  event: AgentEndEventLike;
  ctx: AgentHookContextLike;
  logger?: WritebackLogger;
  now?: () => Date;
}): Promise<{ wrote: boolean; reason?: string }> {
  if (!params.config.writeback.enabled) {
    return { wrote: false, reason: "writeback disabled" };
  }
  if (!Array.isArray(params.event.messages) || params.event.messages.length === 0) {
    return { wrote: false, reason: "no messages" };
  }

  const now = params.now?.() ?? new Date();
  const timestamp = now.toISOString();
  const maxChars = params.config.writeback.maxEntryChars;

  const lastUser = extractLastRoleText(params.event.messages, "user");
  const lastAssistant = extractLastRoleText(params.event.messages, "assistant");
  const task = truncate(squeeze(lastUser) || "N/A", maxChars);
  const summary = buildCompactSummary({
    assistantText: lastAssistant,
    error: params.event.error,
    maxChars,
  });
  const domain = inferDomain(task, summary);
  const tags = inferTags(task, summary, domain);
  const extracted = extractRules(lastAssistant);
  const ruleCandidates = extractRuleCandidates(lastAssistant);
  const decisions =
    extracted.decisions.length > 0
      ? extracted.decisions.map((item) => `Decision: ${item}`)
      : extractTaggedBullets(summary, ["decision:", "decisions:", "- decision:"]).slice(0, 5);
  const todos =
    extracted.todos.length > 0
      ? extracted.todos.map((item) => `TODO: ${item}`)
      : extractTaggedBullets(summary, ["todo:", "next:", "action:"]).slice(0, 5);
  const facts = extracted.facts.map((item) => `Fact: ${item}`);
  const sources = [
    params.ctx.sessionId ? `session:${params.ctx.sessionId}` : "session:unknown",
    params.ctx.agentId ? `agent:${params.ctx.agentId}` : "agent:unknown",
    `status:${params.event.success ? "success" : "failed"}`,
  ];

  await params.store.writeSessionState({
    timestamp,
    task,
    summary,
    decisions,
    todos,
    sources,
  });

  const title = params.event.success ? "Session Summary" : "Session Failure";
  const category = params.event.success ? "session" : "failure";
  const qualityPassed = passesQualityGate({
    qualityGate: params.config.writeback.qualityGate,
    summary,
    decisions,
    todos,
    facts,
    ruleCandidates,
  });
  if (qualityPassed) {
    const midContent = [
      `task: ${task}`,
      "",
      `summary: ${summary}`,
      ...(facts.length > 0 ? ["", ...facts.map((item) => `- ${item}`)] : []),
    ].join("\n");
    await params.store.appendMidEntry({
      timestamp,
      category,
      title,
      domain,
      tags,
      confidence: params.event.success ? 0.75 : 0.35,
      ttlDays: params.event.success ? 30 : 14,
      content: midContent,
      sources: [...sources, ...(params.event.error ? [`error:${params.event.error}`] : [])],
    });
  } else {
    params.logger?.info?.("memory-md-index: mid write skipped by quality gate");
  }

  if (params.config.writeback.proposalsEnabled && ruleCandidates.length > 0) {
    const proposalBody = ["candidate_rules:", ...ruleCandidates.map((item) => `- ${item}`)].join(
      "\n",
    );
    await params.store.appendProposal({
      timestamp,
      title: "Rule Candidates",
      kind: "rules",
      content: proposalBody,
      sources,
    });
  }

  params.logger?.info?.(
    `memory-md-index: writeback complete (${params.event.success ? "success" : "failed"})`,
  );
  return { wrote: true };
}

export const __test_only__ = {
  extractTextFromContent,
  extractLastRoleText,
  extractTaggedBullets,
  extractRuleCandidates,
  stripMarkdownNoise,
  extractRules,
  buildCompactSummary,
  passesQualityGate,
};
