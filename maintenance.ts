import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryMdIndexConfig } from "./config.js";
import {
  appendLifecycleDecisions,
  evaluateLifecycleDecisions,
  readUsageEvents,
} from "./lifecycle.js";
import type { MemoryLayoutPaths, MarkdownMemoryStore } from "./store.js";

type MaintenanceLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type MemoryMaintenanceMode = "auto" | "daily" | "weekly";

export type MemoryMaintenanceResult = {
  mode: MemoryMaintenanceMode;
  archivedSessionState: boolean;
  dedupedFiles: number;
  removedDuplicateBlocks: number;
  promoteCandidates: number;
  archiveCandidates: number;
  weeklyConsolidatedRules: number;
  weeklyConflictPairs: number;
  dailyReportPath: string;
  weeklyReportPath?: string;
  weeklyProposalPath?: string;
};

type WeeklyDecisionState = {
  lastWeekKey?: string;
};

type WeeklyConsolidationResult = {
  consolidatedRules: string[];
  conflicts: Array<{ a: string; b: string; reason: string }>;
  weeklyReportPath: string;
  proposalPath: string;
};

function splitMidBlocks(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\n(?=## \[)/g)
    .map((block) => block.trim())
    .filter(Boolean);
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
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listMarkdownFilesRecursively(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(fullPath);
    }
  }
}

async function dedupeMidFile(
  filePath: string,
): Promise<{ changed: boolean; removedBlocks: number }> {
  const content = await fs.readFile(filePath, "utf8");
  const blocks = splitMidBlocks(content);
  if (blocks.length <= 1) {
    return { changed: false, removedBlocks: 0 };
  }

  const seen = new Set<string>();
  const uniqueBlocks: string[] = [];
  let removedBlocks = 0;
  for (const block of blocks) {
    if (seen.has(block)) {
      removedBlocks++;
      continue;
    }
    seen.add(block);
    uniqueBlocks.push(block);
  }

  if (removedBlocks === 0) {
    return { changed: false, removedBlocks: 0 };
  }

  await fs.writeFile(filePath, `${uniqueBlocks.join("\n\n")}\n`, "utf8");
  return { changed: true, removedBlocks };
}

async function archiveSessionStateIfStale(params: {
  sessionStatePath: string;
  archiveDir: string;
  archiveAfterDays: number;
  now: Date;
}): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.stat(params.sessionStatePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const ageMs = params.now.getTime() - stat.mtime.getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays < params.archiveAfterDays) {
    return false;
  }

  const stamp = params.now.toISOString().replace(/[:.]/g, "-");
  const archiveTarget = path.join(params.archiveDir, `session_state_${stamp}.md`);
  await fs.rename(params.sessionStatePath, archiveTarget);
  return true;
}

function normalizeRule(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ");
}

function extractRulesFromProposal(content: string): string[] {
  const rules: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = normalizeRule(rawLine);
    if (!line) {
      continue;
    }
    const lower = line.toLowerCase();
    if (lower === "candidate_rules:" || lower.startsWith("sources:")) {
      continue;
    }
    if (line.startsWith("- ") || rawLine.trim().startsWith("-")) {
      const rule = normalizeRule(rawLine);
      if (rule) {
        rules.push(rule);
      }
    } else if (lower.startsWith("rule:")) {
      rules.push(line.replace(/^rule:\s*/i, ""));
    }
  }
  return rules;
}

function detectRuleConflicts(rules: string[]): Array<{ a: string; b: string; reason: string }> {
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i].toLowerCase();
      const b = rules[j].toLowerCase();
      if (
        (a.includes("always") && b.includes("never")) ||
        (a.includes("never") && b.includes("always"))
      ) {
        conflicts.push({
          a: rules[i],
          b: rules[j],
          reason: "always_vs_never",
        });
        continue;
      }
      if (
        (a.includes("enable") && b.includes("disable")) ||
        (a.includes("disable") && b.includes("enable"))
      ) {
        conflicts.push({
          a: rules[i],
          b: rules[j],
          reason: "enable_vs_disable",
        });
      }
    }
  }
  return conflicts;
}

function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function readWeeklyState(statePath: string): Promise<WeeklyDecisionState> {
  try {
    const text = await fs.readFile(statePath, "utf8");
    return JSON.parse(text) as WeeklyDecisionState;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {};
    }
    return {};
  }
}

async function writeWeeklyState(statePath: string, state: WeeklyDecisionState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function shouldRunWeeklyForAuto(params: {
  layout: MemoryLayoutPaths;
  config: MemoryMdIndexConfig;
  now: Date;
}): Promise<boolean> {
  if (!params.config.maintenance.weeklyEnabled) {
    return false;
  }
  if (params.now.getUTCDay() !== params.config.maintenance.weeklyWeekday) {
    return false;
  }
  const statePath = path.join(params.layout.rootDir, "meta", "maintenance_state.json");
  const state = await readWeeklyState(statePath);
  const weekKey = isoWeekKey(params.now);
  return state.lastWeekKey !== weekKey;
}

async function markWeeklyDone(layout: MemoryLayoutPaths, now: Date): Promise<void> {
  const statePath = path.join(layout.rootDir, "meta", "maintenance_state.json");
  const state = await readWeeklyState(statePath);
  state.lastWeekKey = isoWeekKey(now);
  await writeWeeklyState(statePath, state);
}

async function runWeeklyConsolidation(params: {
  layout: MemoryLayoutPaths;
  now: Date;
}): Promise<WeeklyConsolidationResult> {
  const proposalFiles: string[] = [];
  await listMarkdownFilesRecursively(params.layout.proposalsDir, proposalFiles);
  const ruleSources = proposalFiles.filter((file) => path.basename(file).startsWith("rules_"));

  const collectedRules: string[] = [];
  for (const file of ruleSources) {
    const content = await fs.readFile(file, "utf8");
    collectedRules.push(...extractRulesFromProposal(content));
  }

  const consolidatedRules = [
    ...new Set(collectedRules.map((rule) => normalizeRule(rule)).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const conflicts = detectRuleConflicts(consolidatedRules);

  const day = params.now.toISOString().slice(0, 10);
  const proposalPath = path.join(params.layout.proposalsDir, `rules_consolidated_${day}.md`);
  const weeklyReportPath = path.join(params.layout.reportsDir, `weekly_${day}.md`);

  const proposalBody = [
    "# Weekly Rule Consolidation",
    "",
    `generated_at: ${params.now.toISOString()}`,
    `rules_count: ${consolidatedRules.length}`,
    "",
    "## Consolidated Rules",
    ...(consolidatedRules.length > 0 ? consolidatedRules.map((rule) => `- ${rule}`) : ["- (none)"]),
    "",
  ].join("\n");
  await fs.writeFile(proposalPath, proposalBody, "utf8");

  const weeklyReport = [
    "# Memory Weekly Report",
    "",
    `generated_at: ${params.now.toISOString()}`,
    `week_key: ${isoWeekKey(params.now)}`,
    `rules_consolidated: ${consolidatedRules.length}`,
    `conflict_pairs: ${conflicts.length}`,
    "",
    "## Conflicts",
    ...(conflicts.length > 0
      ? conflicts.map((item) => `- [${item.reason}] ${item.a} <-> ${item.b}`)
      : ["- (none)"]),
    "",
  ].join("\n");
  await fs.writeFile(weeklyReportPath, weeklyReport, "utf8");

  return {
    consolidatedRules,
    conflicts,
    weeklyReportPath,
    proposalPath,
  };
}

async function writeDailyReport(params: {
  layout: MemoryLayoutPaths;
  now: Date;
  result: Omit<
    MemoryMaintenanceResult,
    "mode" | "dailyReportPath" | "weeklyReportPath" | "weeklyProposalPath"
  >;
}): Promise<string> {
  const day = params.now.toISOString().slice(0, 10);
  const reportPath = path.join(params.layout.reportsDir, `daily_${day}.md`);
  const body = [
    "# Memory Daily Report",
    "",
    `generated_at: ${params.now.toISOString()}`,
    `archived_session_state: ${params.result.archivedSessionState}`,
    `deduped_files: ${params.result.dedupedFiles}`,
    `removed_duplicate_blocks: ${params.result.removedDuplicateBlocks}`,
    `promote_candidates: ${params.result.promoteCandidates}`,
    `archive_candidates: ${params.result.archiveCandidates}`,
    "",
  ].join("\n");
  await fs.writeFile(reportPath, body, "utf8");
  return reportPath;
}

export async function runMemoryMaintenance(params: {
  store: MarkdownMemoryStore;
  config: MemoryMdIndexConfig;
  logger?: MaintenanceLogger;
  now?: () => Date;
  mode?: MemoryMaintenanceMode;
}): Promise<MemoryMaintenanceResult> {
  await params.store.ensureLayout();
  const now = params.now?.() ?? new Date();
  const mode = params.mode ?? "auto";
  const layout = params.store.getLayout();

  const archivedSessionState = await archiveSessionStateIfStale({
    sessionStatePath: layout.sessionStateFile,
    archiveDir: layout.archiveDir,
    archiveAfterDays: params.config.maintenance.archiveAfterDays,
    now,
  });

  let dedupedFiles = 0;
  let removedDuplicateBlocks = 0;
  if (params.config.maintenance.dedupe) {
    const midFiles: string[] = [];
    await listMarkdownFilesRecursively(layout.midDir, midFiles);

    for (const filePath of midFiles) {
      const dedupe = await dedupeMidFile(filePath);
      if (!dedupe.changed) {
        continue;
      }
      dedupedFiles++;
      removedDuplicateBlocks += dedupe.removedBlocks;
    }
  }

  let promoteCandidates = 0;
  let archiveCandidates = 0;
  if (params.config.lifecycle.enabled) {
    const events = await readUsageEvents(layout.rootDir);
    const docs = await params.store.listDocuments({
      includePaths: ["mid", "long"],
      excludePaths: ["archive", "proposals"],
    });
    const decisions = evaluateLifecycleDecisions({
      docs,
      events,
      config: params.config,
      now,
    });
    await appendLifecycleDecisions({
      rootDir: layout.rootDir,
      decisions,
    });
    promoteCandidates = decisions.filter((item) => item.decision === "promote_candidate").length;
    archiveCandidates = decisions.filter((item) => item.decision === "archive_candidate").length;
  }

  let weeklyConsolidatedRules = 0;
  let weeklyConflictPairs = 0;
  let weeklyReportPath: string | undefined;
  let weeklyProposalPath: string | undefined;

  const shouldRunWeekly =
    mode === "weekly" ||
    (mode === "auto" &&
      (await shouldRunWeeklyForAuto({
        layout,
        config: params.config,
        now,
      })));
  if (shouldRunWeekly) {
    const weekly = await runWeeklyConsolidation({
      layout,
      now,
    });
    weeklyConsolidatedRules = weekly.consolidatedRules.length;
    weeklyConflictPairs = weekly.conflicts.length;
    weeklyReportPath = weekly.weeklyReportPath;
    weeklyProposalPath = weekly.proposalPath;
    if (mode === "auto") {
      await markWeeklyDone(layout, now);
    }
  }

  const dailyReportPath = await writeDailyReport({
    layout,
    now,
    result: {
      archivedSessionState,
      dedupedFiles,
      removedDuplicateBlocks,
      promoteCandidates,
      archiveCandidates,
      weeklyConsolidatedRules,
      weeklyConflictPairs,
    },
  });

  if (params.logger?.info) {
    params.logger.info(
      `memory-md-index: maintenance mode=${mode} archivedSessionState=${archivedSessionState} dedupedFiles=${dedupedFiles} removedDuplicateBlocks=${removedDuplicateBlocks} promoteCandidates=${promoteCandidates} archiveCandidates=${archiveCandidates} weeklyConsolidatedRules=${weeklyConsolidatedRules} weeklyConflictPairs=${weeklyConflictPairs}`,
    );
  }

  return {
    mode,
    archivedSessionState,
    dedupedFiles,
    removedDuplicateBlocks,
    promoteCandidates,
    archiveCandidates,
    weeklyConsolidatedRules,
    weeklyConflictPairs,
    dailyReportPath,
    weeklyReportPath,
    weeklyProposalPath,
  };
}
