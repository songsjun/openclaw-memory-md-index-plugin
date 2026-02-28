import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryLayoutPaths = {
  rootDir: string;
  shortDir: string;
  midDir: string;
  longDir: string;
  archiveDir: string;
  proposalsDir: string;
  reportsDir: string;
  sessionStateFile: string;
};

export type SessionStateWrite = {
  timestamp: string;
  task: string;
  summary: string;
  decisions: string[];
  todos: string[];
  sources: string[];
};

export type MidEntryWrite = {
  timestamp: string;
  category: string;
  title: string;
  content: string;
  sources: string[];
  domain?: string;
  tags?: string[];
  confidence?: number;
  ttlDays?: number;
  layer?: "L0" | "L1" | "L2";
  id?: string;
  updatedAt?: string;
};

export type ProposalWrite = {
  timestamp: string;
  title: string;
  content: string;
  sources: string[];
  kind?: "rules" | "skills" | "general";
};

export type MemoryDocumentMetadata = {
  id: string;
  title: string;
  domain: string;
  tags: string[];
  denyTags: string[];
  createdAt: string;
  updatedAt: string;
  source: {
    type: string;
    ref: string;
  };
  confidence: number;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  ttlDays: number;
  layer: "L0" | "L1" | "L2";
};

export type MemoryDocument = {
  absolutePath: string;
  relativePath: string;
  content: string;
  metadata?: MemoryDocumentMetadata;
};

function toPosixRelative(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath).split(path.sep).join("/");
}

function sanitizeDomain(value: string | undefined): string {
  if (!value) {
    return "general";
  }
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-");
  return normalized || "general";
}

function sanitizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const token = tag
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, "-");
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    normalized.push(token);
  }
  return normalized.slice(0, 12);
}

function parseSource(sources: string[]): { type: string; ref: string } {
  const primary = sources.find((source) => source.trim().length > 0) ?? "unknown:unknown";
  const separator = primary.indexOf(":");
  if (separator <= 0) {
    return { type: "unknown", ref: primary };
  }
  return {
    type: primary.slice(0, separator),
    ref: primary.slice(separator + 1),
  };
}

function buildStableEntryId(entry: MidEntryWrite, domain: string): string {
  if (entry.id && entry.id.trim().length > 0) {
    return entry.id.trim();
  }
  const day = entry.timestamp.slice(0, 10).replace(/-/g, "");
  const hash = createHash("sha1")
    .update(`${entry.timestamp}|${domain}|${entry.title}|${entry.content}`)
    .digest("hex")
    .slice(0, 12);
  return `mem_${day}_${hash}`;
}

function metadataDefaults(relativePath: string): MemoryDocumentMetadata {
  const segments = relativePath.split("/");
  const domain = segments[0] === "mid" ? sanitizeDomain(segments[1]) : "general";
  const baseName = path.basename(relativePath, ".md");
  return {
    id: `legacy_${baseName}`,
    title: baseName,
    domain,
    tags: [],
    denyTags: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    source: {
      type: "legacy",
      ref: relativePath,
    },
    confidence: 0.5,
    usageCount: 0,
    successCount: 0,
    failCount: 0,
    lastUsedAt: null,
    ttlDays: 30,
    layer: "L1",
  };
}

function parseFrontmatterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseDocumentMetadata(content: string, relativePath: string): MemoryDocumentMetadata {
  const defaults = metadataDefaults(relativePath);
  const match = content.match(/(?:^|\n)---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return defaults;
  }

  const meta: Record<string, unknown> = {};
  const source: Record<string, unknown> = {};
  let insideSource = false;

  const rows = match[1].split("\n");
  for (const row of rows) {
    if (!row.trim()) {
      continue;
    }
    if (insideSource) {
      const nestedMatch = row.match(/^\s{2}([a-z_]+):\s*(.*)$/);
      if (nestedMatch) {
        source[nestedMatch[1]] = parseFrontmatterValue(nestedMatch[2] ?? "");
        continue;
      }
      insideSource = false;
    }
    if (row.trim() === "source:") {
      insideSource = true;
      continue;
    }
    const pair = row.match(/^([a-z_]+):\s*(.*)$/);
    if (!pair) {
      continue;
    }
    meta[pair[1]] = parseFrontmatterValue(pair[2] ?? "");
  }

  const maybeTags = Array.isArray(meta.tags) ? meta.tags : defaults.tags;
  const maybeDenyTags = Array.isArray(meta.deny_tags) ? meta.deny_tags : defaults.denyTags;
  const asNumber = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const asString = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim().length > 0 ? value : fallback;

  return {
    id: asString(meta.id, defaults.id),
    title: asString(meta.title, defaults.title),
    domain: sanitizeDomain(asString(meta.domain, defaults.domain)),
    tags: sanitizeTags(maybeTags.map((item) => String(item))),
    denyTags: sanitizeTags(maybeDenyTags.map((item) => String(item))),
    createdAt: asString(meta.created_at, defaults.createdAt),
    updatedAt: asString(meta.updated_at, defaults.updatedAt),
    source: {
      type: asString(source.type, defaults.source.type),
      ref: asString(source.ref, defaults.source.ref),
    },
    confidence: asNumber(meta.confidence, defaults.confidence),
    usageCount: asNumber(meta.usage_count, defaults.usageCount),
    successCount: asNumber(meta.success_count, defaults.successCount),
    failCount: asNumber(meta.fail_count, defaults.failCount),
    lastUsedAt:
      meta.last_used_at === null
        ? null
        : asString(meta.last_used_at, defaults.lastUsedAt ?? defaults.updatedAt),
    ttlDays: asNumber(meta.ttl_days, defaults.ttlDays),
    layer:
      meta.layer === "L0" || meta.layer === "L1" || meta.layer === "L2"
        ? meta.layer
        : defaults.layer,
  };
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, targetPath);
}

async function listMarkdownFilesRecursively(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listMarkdownFilesRecursively(abs, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
}

export class MarkdownMemoryStore {
  private readonly layout: MemoryLayoutPaths;

  constructor(params: {
    workspaceDir: string;
    rootDir: string;
    sessionStateFile: string;
    midDir?: string;
  }) {
    const rootDir = path.resolve(params.workspaceDir, params.rootDir);
    const midDirName = params.midDir?.trim() ? params.midDir : "mid";
    this.layout = {
      rootDir,
      shortDir: path.join(rootDir, "short"),
      midDir: path.join(rootDir, midDirName),
      longDir: path.join(rootDir, "long"),
      archiveDir: path.join(rootDir, "archive"),
      proposalsDir: path.join(rootDir, "proposals"),
      reportsDir: path.join(rootDir, "reports"),
      sessionStateFile: path.join(rootDir, params.sessionStateFile),
    };
  }

  getLayout(): MemoryLayoutPaths {
    return this.layout;
  }

  async ensureLayout(): Promise<void> {
    await fs.mkdir(this.layout.shortDir, { recursive: true });
    await fs.mkdir(this.layout.midDir, { recursive: true });
    await fs.mkdir(this.layout.longDir, { recursive: true });
    await fs.mkdir(this.layout.archiveDir, { recursive: true });
    await fs.mkdir(this.layout.proposalsDir, { recursive: true });
    await fs.mkdir(this.layout.reportsDir, { recursive: true });
  }

  async writeSessionState(entry: SessionStateWrite): Promise<void> {
    await this.ensureLayout();
    const body = [
      "# Session State",
      "",
      `updated_at: ${entry.timestamp}`,
      `task: ${entry.task}`,
      "",
      "## Summary",
      entry.summary,
      "",
      "## Decisions",
      ...(entry.decisions.length > 0 ? entry.decisions.map((item) => `- ${item}`) : ["- (none)"]),
      "",
      "## TODO",
      ...(entry.todos.length > 0 ? entry.todos.map((item) => `- ${item}`) : ["- (none)"]),
      "",
      "## Sources",
      ...(entry.sources.length > 0 ? entry.sources.map((item) => `- ${item}`) : ["- (none)"]),
      "",
    ].join("\n");

    await writeFileAtomic(this.layout.sessionStateFile, body);
  }

  async appendMidEntry(entry: MidEntryWrite): Promise<string> {
    await this.ensureLayout();
    const day = entry.timestamp.slice(0, 10);
    const domain = sanitizeDomain(entry.domain);
    const domainDir = path.join(this.layout.midDir, domain);
    await fs.mkdir(domainDir, { recursive: true });
    const filePath = path.join(domainDir, `${day}.md`);
    const tags = sanitizeTags(entry.tags);
    const source = parseSource(entry.sources);
    const id = buildStableEntryId(entry, domain);
    const confidence =
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0.6;
    const ttlDays =
      typeof entry.ttlDays === "number" && Number.isInteger(entry.ttlDays) && entry.ttlDays > 0
        ? entry.ttlDays
        : 30;
    const updatedAt = entry.updatedAt ?? entry.timestamp;
    const layer = entry.layer ?? "L1";
    const block = [
      `## [${entry.timestamp}] ${entry.title}`,
      "",
      "---",
      `id: ${JSON.stringify(id)}`,
      `title: ${JSON.stringify(entry.title)}`,
      `domain: ${JSON.stringify(domain)}`,
      `tags: ${JSON.stringify(tags)}`,
      "deny_tags: []",
      `created_at: ${JSON.stringify(entry.timestamp)}`,
      `updated_at: ${JSON.stringify(updatedAt)}`,
      "source:",
      `  type: ${JSON.stringify(source.type)}`,
      `  ref: ${JSON.stringify(source.ref)}`,
      `confidence: ${confidence.toFixed(2)}`,
      "usage_count: 0",
      "success_count: 0",
      "fail_count: 0",
      "last_used_at: null",
      `ttl_days: ${ttlDays}`,
      `layer: ${JSON.stringify(layer)}`,
      `category: ${entry.category}`,
      "---",
      "",
      entry.content,
      "",
      "sources:",
      ...(entry.sources.length > 0 ? entry.sources.map((item) => `- ${item}`) : ["- (none)"]),
      "",
    ].join("\n");

    await fs.appendFile(filePath, block, "utf8");
    return filePath;
  }

  async appendProposal(entry: ProposalWrite): Promise<string> {
    await this.ensureLayout();
    const day = entry.timestamp.slice(0, 10);
    const kind = entry.kind ?? "general";
    const filePath = path.join(this.layout.proposalsDir, `${kind}_${day}.md`);
    const block = [
      `## [${entry.timestamp}] ${entry.title}`,
      "",
      entry.content,
      "",
      "sources:",
      ...(entry.sources.length > 0 ? entry.sources.map((item) => `- ${item}`) : ["- (none)"]),
      "",
    ].join("\n");
    await fs.appendFile(filePath, block, "utf8");
    return filePath;
  }

  async listDocuments(params?: {
    includePaths?: string[];
    excludePaths?: string[];
  }): Promise<MemoryDocument[]> {
    const includePaths = params?.includePaths ?? ["short", "mid", "long"];
    const excludePaths = (params?.excludePaths ?? [])
      .filter((item) => item.trim().length > 0)
      .map((item) => item.replace(/\/+$/, ""));

    const files: string[] = [];
    for (const includePath of includePaths) {
      const abs = path.join(this.layout.rootDir, includePath);
      await listMarkdownFilesRecursively(abs, files);
    }

    const filtered = files.filter((absPath) => {
      const rel = toPosixRelative(this.layout.rootDir, absPath);
      return !excludePaths.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
    });

    const docs: MemoryDocument[] = [];
    for (const absPath of filtered) {
      const content = await fs.readFile(absPath, "utf8");
      docs.push({
        absolutePath: absPath,
        relativePath: toPosixRelative(this.layout.rootDir, absPath),
        content,
        metadata: parseDocumentMetadata(content, toPosixRelative(this.layout.rootDir, absPath)),
      });
    }
    return docs;
  }
}
