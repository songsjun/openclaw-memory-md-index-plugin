import fs from "node:fs/promises";
import path from "node:path";

export type EvaluationGroup = "G0" | "G1" | "G2" | "G3";

export type EvaluationRecord = {
  taskId: string;
  group: EvaluationGroup;
  success: boolean;
  firstTurn: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  injectedCount: number;
  usefulCitations: number;
  recallTotal: number;
  irrelevantRecall: number;
  longPolluted: boolean;
};

export type GroupStats = {
  group: EvaluationGroup;
  count: number;
  successRate: number;
  firstTurnRate: number;
  usefulCitationRate: number;
  irrelevantRecallRate: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  p95LatencyMs: number;
  longPollutionRate: number;
};

type GateCheck = {
  id: string;
  passed: boolean;
  detail: string;
};

export type EvaluationSummary = {
  groups: Record<EvaluationGroup, GroupStats>;
  deltas: {
    g2VsG0Success: number;
    g2VsG0IrrelevantRecall: number;
    g3VsG2Success: number;
    g3VsG2LongPollution: number;
    g2VsG0InputTokens: number;
    g2VsG0P95Latency: number;
  };
  confidence: {
    g2VsG0Success95: [number, number];
    g3VsG2Success95: [number, number];
  };
  gate: {
    go: boolean;
    checks: GateCheck[];
  };
};

function safeDiv(a: number, b: number): number {
  if (b <= 0) {
    return 0;
  }
  return a / b;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)];
}

function computeStats(group: EvaluationGroup, records: EvaluationRecord[]): GroupStats {
  const success = records.filter((item) => item.success).length;
  const firstTurn = records.filter((item) => item.firstTurn).length;
  const usefulCitations = records.reduce((sum, item) => sum + item.usefulCitations, 0);
  const injected = records.reduce((sum, item) => sum + item.injectedCount, 0);
  const irrelevant = records.reduce((sum, item) => sum + item.irrelevantRecall, 0);
  const recallTotal = records.reduce((sum, item) => sum + item.recallTotal, 0);
  const longPolluted = records.filter((item) => item.longPolluted).length;

  return {
    group,
    count: records.length,
    successRate: safeDiv(success, records.length),
    firstTurnRate: safeDiv(firstTurn, records.length),
    usefulCitationRate: safeDiv(usefulCitations, injected),
    irrelevantRecallRate: safeDiv(irrelevant, recallTotal),
    avgInputTokens: mean(records.map((item) => item.inputTokens)),
    avgOutputTokens: mean(records.map((item) => item.outputTokens)),
    p95LatencyMs: p95(records.map((item) => item.latencyMs)),
    longPollutionRate: safeDiv(longPolluted, records.length),
  };
}

type LcgState = {
  seed: number;
};

function lcgRandom(state: LcgState): number {
  state.seed = (1664525 * state.seed + 1013904223) >>> 0;
  return state.seed / 0xffffffff;
}

function bootstrapSuccessDiff95(params: {
  a: EvaluationRecord[];
  b: EvaluationRecord[];
  rounds?: number;
  seed?: number;
}): [number, number] {
  const rounds = params.rounds ?? 1200;
  if (params.a.length === 0 || params.b.length === 0) {
    return [0, 0];
  }
  const rng = { seed: params.seed ?? 42 };
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    let aSuccess = 0;
    let bSuccess = 0;
    for (let j = 0; j < params.a.length; j++) {
      const idx = Math.floor(lcgRandom(rng) * params.a.length);
      if (params.a[idx]?.success) {
        aSuccess++;
      }
    }
    for (let j = 0; j < params.b.length; j++) {
      const idx = Math.floor(lcgRandom(rng) * params.b.length);
      if (params.b[idx]?.success) {
        bSuccess++;
      }
    }
    samples.push(safeDiv(aSuccess, params.a.length) - safeDiv(bSuccess, params.b.length));
  }
  samples.sort((x, y) => x - y);
  const lo = samples[Math.floor(rounds * 0.025)] ?? 0;
  const hi = samples[Math.floor(rounds * 0.975)] ?? 0;
  return [lo, hi];
}

function toPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function assertGroupRecords(
  records: EvaluationRecord[],
  group: EvaluationGroup,
): EvaluationRecord[] {
  return records.filter((item) => item.group === group);
}

export function summarizeEvaluation(records: EvaluationRecord[]): EvaluationSummary {
  const g0Records = assertGroupRecords(records, "G0");
  const g1Records = assertGroupRecords(records, "G1");
  const g2Records = assertGroupRecords(records, "G2");
  const g3Records = assertGroupRecords(records, "G3");

  const groups: Record<EvaluationGroup, GroupStats> = {
    G0: computeStats("G0", g0Records),
    G1: computeStats("G1", g1Records),
    G2: computeStats("G2", g2Records),
    G3: computeStats("G3", g3Records),
  };

  const deltas = {
    g2VsG0Success: groups.G2.successRate - groups.G0.successRate,
    g2VsG0IrrelevantRecall: groups.G2.irrelevantRecallRate - groups.G0.irrelevantRecallRate,
    g3VsG2Success: groups.G3.successRate - groups.G2.successRate,
    g3VsG2LongPollution: groups.G3.longPollutionRate - groups.G2.longPollutionRate,
    g2VsG0InputTokens: safeDiv(
      groups.G2.avgInputTokens - groups.G0.avgInputTokens,
      Math.max(groups.G0.avgInputTokens, 1),
    ),
    g2VsG0P95Latency: safeDiv(
      groups.G2.p95LatencyMs - groups.G0.p95LatencyMs,
      Math.max(groups.G0.p95LatencyMs, 1),
    ),
  };

  const confidence = {
    g2VsG0Success95: bootstrapSuccessDiff95({
      a: g2Records,
      b: g0Records,
      seed: 1337,
    }),
    g3VsG2Success95: bootstrapSuccessDiff95({
      a: g3Records,
      b: g2Records,
      seed: 2048,
    }),
  };

  const checks: GateCheck[] = [
    {
      id: "g2_success_vs_g0",
      passed: deltas.g2VsG0Success >= 0.08,
      detail: `G2-G0 success delta ${toPercent(deltas.g2VsG0Success)} (required >= 8.00%)`,
    },
    {
      id: "g2_irrelevant_recall_vs_g0",
      passed: deltas.g2VsG0IrrelevantRecall <= 0.02,
      detail: `G2-G0 irrelevant recall delta ${toPercent(deltas.g2VsG0IrrelevantRecall)} (required <= 2.00%)`,
    },
    {
      id: "g3_success_vs_g2",
      passed: deltas.g3VsG2Success >= 0.03,
      detail: `G3-G2 success delta ${toPercent(deltas.g3VsG2Success)} (required >= 3.00%)`,
    },
    {
      id: "g3_long_pollution_vs_g2",
      passed: deltas.g3VsG2LongPollution <= 0,
      detail: `G3-G2 long pollution delta ${toPercent(deltas.g3VsG2LongPollution)} (required <= 0.00%)`,
    },
    {
      id: "token_growth_limit",
      passed: deltas.g2VsG0InputTokens <= 0.2,
      detail: `G2-G0 input token growth ${toPercent(deltas.g2VsG0InputTokens)} (required <= 20.00%)`,
    },
    {
      id: "latency_growth_limit",
      passed: deltas.g2VsG0P95Latency <= 0.15,
      detail: `G2-G0 p95 latency growth ${toPercent(deltas.g2VsG0P95Latency)} (required <= 15.00%)`,
    },
  ];

  return {
    groups,
    deltas,
    confidence,
    gate: {
      go: checks.every((item) => item.passed),
      checks,
    },
  };
}

export async function readEvaluationRecords(inputPath: string): Promise<EvaluationRecord[]> {
  const content = await fs.readFile(inputPath, "utf8");
  const records: EvaluationRecord[] = [];
  for (const row of content.split("\n")) {
    const trimmed = row.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as EvaluationRecord;
    records.push(parsed);
  }
  return records;
}

function renderGroupLine(group: GroupStats): string {
  return `| ${group.group} | ${group.count} | ${toPercent(group.successRate)} | ${toPercent(group.firstTurnRate)} | ${toPercent(group.usefulCitationRate)} | ${toPercent(group.irrelevantRecallRate)} | ${group.avgInputTokens.toFixed(1)} | ${group.p95LatencyMs.toFixed(1)} | ${toPercent(group.longPollutionRate)} |`;
}

export function renderEvaluationMarkdown(summary: EvaluationSummary): string {
  const lines: string[] = [];
  lines.push("# Memory Evaluation Report");
  lines.push("");
  lines.push(`gate_result: ${summary.gate.go ? "GO" : "NO_GO"}`);
  lines.push("");
  lines.push("## Group Metrics");
  lines.push("");
  lines.push(
    "| Group | N | Success | FirstTurn | UsefulCitation | IrrelevantRecall | AvgInputTokens | P95LatencyMs | LongPollution |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(renderGroupLine(summary.groups.G0));
  lines.push(renderGroupLine(summary.groups.G1));
  lines.push(renderGroupLine(summary.groups.G2));
  lines.push(renderGroupLine(summary.groups.G3));
  lines.push("");
  lines.push("## Deltas");
  lines.push("");
  lines.push(`- G2 vs G0 success delta: ${toPercent(summary.deltas.g2VsG0Success)}`);
  lines.push(
    `- G2 vs G0 irrelevant recall delta: ${toPercent(summary.deltas.g2VsG0IrrelevantRecall)}`,
  );
  lines.push(`- G3 vs G2 success delta: ${toPercent(summary.deltas.g3VsG2Success)}`);
  lines.push(`- G3 vs G2 long pollution delta: ${toPercent(summary.deltas.g3VsG2LongPollution)}`);
  lines.push(`- G2 vs G0 input token growth: ${toPercent(summary.deltas.g2VsG0InputTokens)}`);
  lines.push(`- G2 vs G0 p95 latency growth: ${toPercent(summary.deltas.g2VsG0P95Latency)}`);
  lines.push("");
  lines.push("## Confidence Intervals (Bootstrap 95%)");
  lines.push("");
  lines.push(
    `- G2 vs G0 success delta 95% CI: [${toPercent(summary.confidence.g2VsG0Success95[0])}, ${toPercent(summary.confidence.g2VsG0Success95[1])}]`,
  );
  lines.push(
    `- G3 vs G2 success delta 95% CI: [${toPercent(summary.confidence.g3VsG2Success95[0])}, ${toPercent(summary.confidence.g3VsG2Success95[1])}]`,
  );
  lines.push("");
  lines.push("## Gate Checks");
  lines.push("");
  for (const check of summary.gate.checks) {
    lines.push(`- [${check.passed ? "PASS" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function runEvaluation(params: { inputPath: string; outputPath?: string }): Promise<{
  summary: EvaluationSummary;
  outputPath: string;
}> {
  const records = await readEvaluationRecords(params.inputPath);
  const summary = summarizeEvaluation(records);
  const markdown = renderEvaluationMarkdown(summary);
  const outputPath =
    params.outputPath ?? path.join(path.dirname(params.inputPath), "evaluation-report.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, "utf8");
  return {
    summary,
    outputPath,
  };
}
