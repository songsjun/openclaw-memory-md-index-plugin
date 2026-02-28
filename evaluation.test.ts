import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderEvaluationMarkdown,
  runEvaluation,
  summarizeEvaluation,
  type EvaluationGroup,
  type EvaluationRecord,
} from "./evaluation.js";

function makeGroupRecords(params: {
  group: EvaluationGroup;
  count: number;
  successRate: number;
  firstTurnRate: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  usefulCitationRate: number;
  irrelevantRecallRate: number;
  longPollutionRate: number;
}): EvaluationRecord[] {
  const records: EvaluationRecord[] = [];
  const successCutoff = Math.round(params.count * params.successRate);
  const firstTurnCutoff = Math.round(params.count * params.firstTurnRate);
  const pollutedCutoff = Math.round(params.count * params.longPollutionRate);
  for (let i = 0; i < params.count; i++) {
    const injectedCount = 4;
    const recallTotal = 4;
    records.push({
      taskId: `${params.group}-${i}`,
      group: params.group,
      success: i < successCutoff,
      firstTurn: i < firstTurnCutoff,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      latencyMs: params.latencyMs,
      injectedCount,
      usefulCitations: Math.round(injectedCount * params.usefulCitationRate),
      recallTotal,
      irrelevantRecall: Math.round(recallTotal * params.irrelevantRecallRate),
      longPolluted: i < pollutedCutoff,
    });
  }
  return records;
}

describe("evaluation", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-eval-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns GO when gate thresholds are met", () => {
    const records = [
      ...makeGroupRecords({
        group: "G0",
        count: 50,
        successRate: 0.58,
        firstTurnRate: 0.5,
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 1000,
        usefulCitationRate: 0.35,
        irrelevantRecallRate: 0.05,
        longPollutionRate: 0.06,
      }),
      ...makeGroupRecords({
        group: "G1",
        count: 50,
        successRate: 0.62,
        firstTurnRate: 0.54,
        inputTokens: 1050,
        outputTokens: 510,
        latencyMs: 1040,
        usefulCitationRate: 0.4,
        irrelevantRecallRate: 0.05,
        longPollutionRate: 0.06,
      }),
      ...makeGroupRecords({
        group: "G2",
        count: 50,
        successRate: 0.7,
        firstTurnRate: 0.62,
        inputTokens: 1140,
        outputTokens: 520,
        latencyMs: 1120,
        usefulCitationRate: 0.58,
        irrelevantRecallRate: 0.06,
        longPollutionRate: 0.05,
      }),
      ...makeGroupRecords({
        group: "G3",
        count: 50,
        successRate: 0.76,
        firstTurnRate: 0.66,
        inputTokens: 1150,
        outputTokens: 525,
        latencyMs: 1130,
        usefulCitationRate: 0.6,
        irrelevantRecallRate: 0.06,
        longPollutionRate: 0.04,
      }),
    ];

    const summary = summarizeEvaluation(records);
    expect(summary.gate.go).toBe(true);
    expect(summary.gate.checks.every((item) => item.passed)).toBe(true);

    const markdown = renderEvaluationMarkdown(summary);
    expect(markdown).toContain("gate_result: GO");
    expect(markdown).toContain("Group Metrics");
  });

  it("returns NO_GO and writes report file", async () => {
    const records = [
      ...makeGroupRecords({
        group: "G0",
        count: 20,
        successRate: 0.6,
        firstTurnRate: 0.55,
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 900,
        usefulCitationRate: 0.35,
        irrelevantRecallRate: 0.04,
        longPollutionRate: 0.05,
      }),
      ...makeGroupRecords({
        group: "G1",
        count: 20,
        successRate: 0.61,
        firstTurnRate: 0.56,
        inputTokens: 1010,
        outputTokens: 500,
        latencyMs: 910,
        usefulCitationRate: 0.36,
        irrelevantRecallRate: 0.04,
        longPollutionRate: 0.05,
      }),
      ...makeGroupRecords({
        group: "G2",
        count: 20,
        successRate: 0.62,
        firstTurnRate: 0.57,
        inputTokens: 1300,
        outputTokens: 520,
        latencyMs: 1200,
        usefulCitationRate: 0.36,
        irrelevantRecallRate: 0.1,
        longPollutionRate: 0.07,
      }),
      ...makeGroupRecords({
        group: "G3",
        count: 20,
        successRate: 0.63,
        firstTurnRate: 0.58,
        inputTokens: 1320,
        outputTokens: 530,
        latencyMs: 1220,
        usefulCitationRate: 0.37,
        irrelevantRecallRate: 0.1,
        longPollutionRate: 0.09,
      }),
    ];

    const inputPath = path.join(tmpDir, "eval.jsonl");
    const outputPath = path.join(tmpDir, "report.md");
    await fs.writeFile(inputPath, records.map((item) => JSON.stringify(item)).join("\n"), "utf8");

    const result = await runEvaluation({
      inputPath,
      outputPath,
    });

    expect(result.summary.gate.go).toBe(false);
    const report = await fs.readFile(outputPath, "utf8");
    expect(report).toContain("gate_result: NO_GO");
    expect(report).toContain("FAIL");
  });
});
