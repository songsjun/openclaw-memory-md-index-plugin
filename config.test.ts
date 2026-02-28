import { describe, expect, it } from "vitest";
import { getDefaultMemoryMdIndexConfig, memoryMdIndexConfigSchema } from "./config.js";

describe("memory-md-index config", () => {
  it("returns defaults when config is omitted", () => {
    const cfg = memoryMdIndexConfigSchema.parse(undefined);
    expect(cfg).toEqual(getDefaultMemoryMdIndexConfig());
    expect(cfg.retrieve.backend).toBe("rg");
    expect(cfg.retrieve.topK).toBe(5);
    expect(cfg.retrieve.rerank).toBe(true);
    expect(cfg.route.enabled).toBe(true);
    expect(cfg.route.fallbackCrossDomainDocs).toBe(1);
    expect(cfg.route.denyTags).toEqual(["do_not_recall"]);
    expect(cfg.writeback.qualityGate).toBe("basic");
    expect(cfg.writeback.proposalsEnabled).toBe(true);
    expect(cfg.lifecycle.enabled).toBe(true);
    expect(cfg.lifecycle.promoteThreshold).toBe(0.75);
    expect(cfg.lifecycle.archiveThreshold).toBe(0.35);
    expect(cfg.lifecycle.archiveInactiveDays).toBe(30);
    expect(cfg.maintenance.archiveAfterDays).toBe(7);
    expect(cfg.maintenance.dedupe).toBe(true);
    expect(cfg.maintenance.weeklyEnabled).toBe(true);
    expect(cfg.maintenance.weeklyWeekday).toBe(1);
  });

  it("accepts explicit overrides", () => {
    const cfg = memoryMdIndexConfigSchema.parse({
      rootDir: "memory-data",
      retrieve: {
        backend: "bm25",
        topK: 8,
        maxChars: 6000,
        rerank: false,
        includePaths: ["short", "mid"],
        excludePaths: ["archive"],
      },
      route: {
        enabled: true,
        fallbackCrossDomainDocs: 2,
        denyTags: ["secret", "private"],
      },
      writeback: {
        enabled: true,
        sessionStateFile: "short/custom_session.md",
        midDir: "notes",
        maxEntryChars: 2048,
        qualityGate: "strict",
        proposalsEnabled: false,
      },
      maintenance: {
        enabled: true,
        intervalMinutes: 720,
        archiveAfterDays: 14,
        dedupe: false,
        weeklyEnabled: false,
        weeklyWeekday: 4,
      },
      lifecycle: {
        enabled: true,
        promoteThreshold: 0.8,
        archiveThreshold: 0.2,
        archiveInactiveDays: 45,
      },
      debug: true,
    });

    expect(cfg.rootDir).toBe("memory-data");
    expect(cfg.retrieve.backend).toBe("bm25");
    expect(cfg.retrieve.topK).toBe(8);
    expect(cfg.retrieve.maxChars).toBe(6000);
    expect(cfg.retrieve.rerank).toBe(false);
    expect(cfg.route.fallbackCrossDomainDocs).toBe(2);
    expect(cfg.route.denyTags).toEqual(["secret", "private"]);
    expect(cfg.writeback.sessionStateFile).toBe("short/custom_session.md");
    expect(cfg.writeback.midDir).toBe("notes");
    expect(cfg.writeback.qualityGate).toBe("strict");
    expect(cfg.writeback.proposalsEnabled).toBe(false);
    expect(cfg.maintenance.intervalMinutes).toBe(720);
    expect(cfg.maintenance.archiveAfterDays).toBe(14);
    expect(cfg.maintenance.dedupe).toBe(false);
    expect(cfg.maintenance.weeklyEnabled).toBe(false);
    expect(cfg.maintenance.weeklyWeekday).toBe(4);
    expect(cfg.lifecycle.promoteThreshold).toBe(0.8);
    expect(cfg.lifecycle.archiveThreshold).toBe(0.2);
    expect(cfg.lifecycle.archiveInactiveDays).toBe(45);
    expect(cfg.debug).toBe(true);
  });

  it("rejects unknown backend", () => {
    expect(() =>
      memoryMdIndexConfigSchema.parse({
        retrieve: {
          backend: "invalid",
        },
      }),
    ).toThrow("retrieve.backend must be one of: rg, bm25, vector");
  });

  it("rejects out-of-range topK", () => {
    expect(() =>
      memoryMdIndexConfigSchema.parse({
        retrieve: {
          topK: 99,
        },
      }),
    ).toThrow("retrieve.topK must be between 1 and 50");
  });

  it("rejects out-of-range route fallback docs", () => {
    expect(() =>
      memoryMdIndexConfigSchema.parse({
        route: {
          fallbackCrossDomainDocs: 20,
        },
      }),
    ).toThrow("route.fallbackCrossDomainDocs must be between 0 and 10");
  });

  it("rejects unknown writeback quality gate", () => {
    expect(() =>
      memoryMdIndexConfigSchema.parse({
        writeback: {
          qualityGate: "aggressive",
        },
      }),
    ).toThrow("writeback.qualityGate must be one of: off, basic, strict");
  });

  it("rejects lifecycle thresholds outside [0,1]", () => {
    expect(() =>
      memoryMdIndexConfigSchema.parse({
        lifecycle: {
          promoteThreshold: 1.2,
        },
      }),
    ).toThrow("lifecycle.promoteThreshold must be between 0 and 1");
  });

  it("rejects maintenance.weeklyWeekday out of range", () => {
    expect(() =>
      memoryMdIndexConfigSchema.parse({
        maintenance: {
          weeklyWeekday: 9,
        },
      }),
    ).toThrow("maintenance.weeklyWeekday must be between 0 and 6");
  });
});
