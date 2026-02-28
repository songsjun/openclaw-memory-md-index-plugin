import { spawn } from "node:child_process";
import path from "node:path";
import type { MemoryMdIndexConfig } from "./config.js";
import type { MemoryDocument } from "./store.js";

export type MemorySearchHit = {
  relativePath: string;
  line?: number;
  snippet: string;
  score: number;
};

export type MemoryIndex = {
  name: string;
  search: (params: {
    query: string;
    topK: number;
    docs: MemoryDocument[];
    memoryRootDir: string;
  }) => Promise<MemorySearchHit[]>;
};

type IndexLogger = {
  warn?: (message: string) => void;
};

class FallbackMemoryIndex implements MemoryIndex {
  name: string;

  constructor(
    primaryName: string,
    private readonly primary: MemoryIndex,
    private readonly fallback: MemoryIndex,
    private readonly logger?: IndexLogger,
  ) {
    this.name = primaryName;
  }

  async search(params: {
    query: string;
    topK: number;
    docs: MemoryDocument[];
    memoryRootDir: string;
  }): Promise<MemorySearchHit[]> {
    try {
      return await this.primary.search(params);
    } catch (error) {
      this.logger?.warn?.(
        `memory-md-index: ${this.name} backend failed, fallback to ${this.fallback.name}: ${String(error)}`,
      );
      return this.fallback.search(params);
    }
  }
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((token) => token.length > 1);
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractSnippet(content: string, queryTokens: string[], maxChars = 240): string {
  const normalized = content.replace(/\r/g, "");
  const lower = normalized.toLowerCase();
  let bestIndex = -1;
  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }
  if (bestIndex === -1) {
    return squeeze(normalized.slice(0, maxChars));
  }
  const start = Math.max(0, bestIndex - Math.floor(maxChars / 3));
  const end = Math.min(normalized.length, start + maxChars);
  return squeeze(normalized.slice(start, end));
}

function normalizePathToRelative(memoryRootDir: string, absolutePath: string): string {
  const relative = path.relative(memoryRootDir, absolutePath);
  return relative.split(path.sep).join("/");
}

async function runCommand(params: {
  command: string;
  args: string[];
  stdin?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    if (params.stdin) {
      child.stdin.write(params.stdin, "utf8");
    }
    child.stdin.end();
  });
}

class RgMemoryIndex implements MemoryIndex {
  name = "rg";

  constructor(private readonly rgCommand: string) {}

  async search(params: {
    query: string;
    topK: number;
    docs: MemoryDocument[];
    memoryRootDir: string;
  }): Promise<MemorySearchHit[]> {
    if (params.docs.length === 0) {
      return [];
    }

    const filePaths = params.docs.map((doc) => doc.absolutePath);
    const args = [
      "--no-heading",
      "--line-number",
      "--color",
      "never",
      "--smart-case",
      "--max-count",
      "4",
      params.query,
      ...filePaths,
    ];
    const result = await runCommand({ command: this.rgCommand, args });
    if (result.code === 1) {
      return [];
    }
    if (result.code !== 0) {
      throw new Error(`rg exited with code ${result.code}: ${result.stderr || "unknown error"}`);
    }

    const lines = result.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const hits: MemorySearchHit[] = [];
    for (const line of lines) {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) {
        continue;
      }
      const absolutePath = match[1];
      const lineNo = Number.parseInt(match[2], 10);
      const snippet = squeeze(match[3] ?? "");
      if (!snippet) {
        continue;
      }
      hits.push({
        relativePath: normalizePathToRelative(params.memoryRootDir, absolutePath),
        line: Number.isFinite(lineNo) ? lineNo : undefined,
        snippet,
        score: 1,
      });
    }

    return hits.slice(0, params.topK).map((hit, index) => ({ ...hit, score: 1 / (index + 1) }));
  }
}

class Bm25MemoryIndex implements MemoryIndex {
  name = "bm25";

  async search(params: {
    query: string;
    topK: number;
    docs: MemoryDocument[];
    memoryRootDir: string;
  }): Promise<MemorySearchHit[]> {
    if (params.docs.length === 0) {
      return [];
    }

    const queryTokens = [...new Set(tokenize(params.query))];
    if (queryTokens.length === 0) {
      return [];
    }

    const docStats = params.docs.map((doc) => {
      const tokens = tokenize(doc.content);
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      return { doc, tf, tokenCount: tokens.length };
    });

    const avgDocLen =
      docStats.reduce((sum, stat) => sum + stat.tokenCount, 0) / Math.max(docStats.length, 1);
    const docFreq = new Map<string, number>();
    for (const token of queryTokens) {
      let count = 0;
      for (const stat of docStats) {
        if ((stat.tf.get(token) ?? 0) > 0) {
          count++;
        }
      }
      docFreq.set(token, count);
    }

    const k1 = 1.5;
    const b = 0.75;
    const scored = docStats
      .map((stat) => {
        let score = 0;
        for (const token of queryTokens) {
          const tf = stat.tf.get(token) ?? 0;
          if (tf <= 0) {
            continue;
          }
          const df = docFreq.get(token) ?? 0;
          const idf = Math.log(1 + (docStats.length - df + 0.5) / (df + 0.5));
          const denom = tf + k1 * (1 - b + b * (stat.tokenCount / Math.max(avgDocLen, 1)));
          score += idf * ((tf * (k1 + 1)) / Math.max(denom, 0.0001));
        }
        return {
          doc: stat.doc,
          score,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, params.topK);

    return scored.map((entry) => ({
      relativePath: entry.doc.relativePath,
      snippet: extractSnippet(entry.doc.content, queryTokens),
      score: entry.score,
    }));
  }
}

class ExternalVectorMemoryIndex implements MemoryIndex {
  name = "vector";

  constructor(
    private readonly command: string,
    private readonly fallback: MemoryIndex,
    private readonly logger?: IndexLogger,
  ) {}

  async search(params: {
    query: string;
    topK: number;
    docs: MemoryDocument[];
    memoryRootDir: string;
  }): Promise<MemorySearchHit[]> {
    if (params.docs.length === 0) {
      return [];
    }

    const payload = JSON.stringify({
      query: params.query,
      topK: params.topK,
      docs: params.docs.map((doc) => ({
        relativePath: doc.relativePath,
        content: doc.content,
      })),
    });

    try {
      const result = await runCommand({
        command: this.command,
        args: [],
        stdin: payload,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr || `vector command exited with code ${result.code}`);
      }
      const parsed = JSON.parse(result.stdout) as Array<{
        relativePath: string;
        snippet: string;
        score: number;
        line?: number;
      }>;
      if (!Array.isArray(parsed)) {
        throw new Error("vector command output must be a JSON array");
      }
      return parsed
        .filter(
          (hit) =>
            typeof hit?.relativePath === "string" &&
            typeof hit?.snippet === "string" &&
            typeof hit?.score === "number" &&
            Number.isFinite(hit.score),
        )
        .slice(0, params.topK)
        .map((hit) => ({
          relativePath: hit.relativePath,
          snippet: squeeze(hit.snippet),
          score: hit.score,
          line: hit.line,
        }));
    } catch (error) {
      this.logger?.warn?.(
        `memory-md-index: vector backend failed, fallback to bm25: ${String(error)}`,
      );
      return this.fallback.search(params);
    }
  }
}

class VectorFallbackMemoryIndex implements MemoryIndex {
  name = "vector";

  constructor(
    private readonly fallback: MemoryIndex,
    private readonly logger?: IndexLogger,
  ) {}

  async search(params: {
    query: string;
    topK: number;
    docs: MemoryDocument[];
    memoryRootDir: string;
  }): Promise<MemorySearchHit[]> {
    this.logger?.warn?.(
      "memory-md-index: vector backend selected without retrieve.vectorCommand; using bm25 fallback",
    );
    return this.fallback.search(params);
  }
}

export function createMemoryIndexBackend(params: {
  config: MemoryMdIndexConfig;
  logger?: IndexLogger;
}): MemoryIndex {
  const bm25 = new Bm25MemoryIndex();
  if (params.config.retrieve.backend === "bm25") {
    return bm25;
  }
  if (params.config.retrieve.backend === "rg") {
    return new FallbackMemoryIndex(
      "rg",
      new RgMemoryIndex(params.config.retrieve.rgCommand),
      bm25,
      params.logger,
    );
  }
  if (params.config.retrieve.vectorCommand) {
    return new ExternalVectorMemoryIndex(params.config.retrieve.vectorCommand, bm25, params.logger);
  }
  return new VectorFallbackMemoryIndex(bm25, params.logger);
}
