import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export type MemoryIndexBackend = "rg" | "bm25" | "vector";

export type MemoryMdIndexConfig = {
  rootDir: string;
  retrieve: {
    backend: MemoryIndexBackend;
    topK: number;
    maxChars: number;
    rerank: boolean;
    includePaths: string[];
    excludePaths: string[];
    rgCommand: string;
    vectorCommand?: string;
  };
  route: {
    enabled: boolean;
    fallbackCrossDomainDocs: number;
    denyTags: string[];
  };
  writeback: {
    enabled: boolean;
    sessionStateFile: string;
    midDir: string;
    maxEntryChars: number;
    qualityGate: "off" | "basic" | "strict";
    proposalsEnabled: boolean;
  };
  maintenance: {
    enabled: boolean;
    intervalMinutes: number;
    archiveAfterDays: number;
    dedupe: boolean;
    weeklyEnabled: boolean;
    weeklyWeekday: number;
  };
  lifecycle: {
    enabled: boolean;
    promoteThreshold: number;
    archiveThreshold: number;
    archiveInactiveDays: number;
  };
  debug: boolean;
};

const DEFAULT_CONFIG: MemoryMdIndexConfig = {
  rootDir: "memory",
  retrieve: {
    backend: "rg",
    topK: 5,
    maxChars: 3200,
    rerank: true,
    includePaths: ["short", "mid", "long"],
    excludePaths: ["archive", "proposals"],
    rgCommand: "rg",
  },
  route: {
    enabled: true,
    fallbackCrossDomainDocs: 1,
    denyTags: ["do_not_recall"],
  },
  writeback: {
    enabled: true,
    sessionStateFile: "short/session_state.md",
    midDir: "mid",
    maxEntryChars: 1200,
    qualityGate: "basic",
    proposalsEnabled: true,
  },
  maintenance: {
    enabled: false,
    intervalMinutes: 1440,
    archiveAfterDays: 7,
    dedupe: true,
    weeklyEnabled: true,
    weeklyWeekday: 1,
  },
  lifecycle: {
    enabled: true,
    promoteThreshold: 0.75,
    archiveThreshold: 0.35,
    archiveInactiveDays: 30,
  },
  debug: false,
};

const BACKENDS: ReadonlySet<MemoryIndexBackend> = new Set(["rg", "bm25", "vector"]);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asObject(value, "config section");
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function asPositiveInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function asNumberInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function parseRetrieve(value: unknown): MemoryMdIndexConfig["retrieve"] {
  const section = asOptionalObject(value);
  const backendRaw = section?.backend;
  const backend =
    backendRaw === undefined
      ? DEFAULT_CONFIG.retrieve.backend
      : (asString(backendRaw, "retrieve.backend") as MemoryIndexBackend);

  if (!BACKENDS.has(backend)) {
    throw new Error(`retrieve.backend must be one of: ${Array.from(BACKENDS).join(", ")}`);
  }

  return {
    backend,
    topK:
      section?.topK === undefined
        ? DEFAULT_CONFIG.retrieve.topK
        : asPositiveInt(section.topK, "retrieve.topK", 1, 50),
    maxChars:
      section?.maxChars === undefined
        ? DEFAULT_CONFIG.retrieve.maxChars
        : asPositiveInt(section.maxChars, "retrieve.maxChars", 200, 20_000),
    rerank:
      section?.rerank === undefined
        ? DEFAULT_CONFIG.retrieve.rerank
        : asBoolean(section.rerank, "retrieve.rerank"),
    includePaths:
      section?.includePaths === undefined
        ? [...DEFAULT_CONFIG.retrieve.includePaths]
        : asStringArray(section.includePaths, "retrieve.includePaths"),
    excludePaths:
      section?.excludePaths === undefined
        ? [...DEFAULT_CONFIG.retrieve.excludePaths]
        : asStringArray(section.excludePaths, "retrieve.excludePaths"),
    rgCommand:
      section?.rgCommand === undefined
        ? DEFAULT_CONFIG.retrieve.rgCommand
        : asString(section.rgCommand, "retrieve.rgCommand"),
    vectorCommand:
      section?.vectorCommand === undefined
        ? undefined
        : asString(section.vectorCommand, "retrieve.vectorCommand"),
  };
}

function parseWriteback(value: unknown): MemoryMdIndexConfig["writeback"] {
  const section = asOptionalObject(value);
  let qualityGate = DEFAULT_CONFIG.writeback.qualityGate;
  if (section?.qualityGate !== undefined) {
    const candidate = asString(section.qualityGate, "writeback.qualityGate");
    if (candidate !== "off" && candidate !== "basic" && candidate !== "strict") {
      throw new Error("writeback.qualityGate must be one of: off, basic, strict");
    }
    qualityGate = candidate;
  }
  return {
    enabled:
      section?.enabled === undefined
        ? DEFAULT_CONFIG.writeback.enabled
        : asBoolean(section.enabled, "writeback.enabled"),
    sessionStateFile:
      section?.sessionStateFile === undefined
        ? DEFAULT_CONFIG.writeback.sessionStateFile
        : asString(section.sessionStateFile, "writeback.sessionStateFile"),
    midDir:
      section?.midDir === undefined
        ? DEFAULT_CONFIG.writeback.midDir
        : asString(section.midDir, "writeback.midDir"),
    maxEntryChars:
      section?.maxEntryChars === undefined
        ? DEFAULT_CONFIG.writeback.maxEntryChars
        : asPositiveInt(section.maxEntryChars, "writeback.maxEntryChars", 100, 10_000),
    qualityGate,
    proposalsEnabled:
      section?.proposalsEnabled === undefined
        ? DEFAULT_CONFIG.writeback.proposalsEnabled
        : asBoolean(section.proposalsEnabled, "writeback.proposalsEnabled"),
  };
}

function parseRoute(value: unknown): MemoryMdIndexConfig["route"] {
  const section = asOptionalObject(value);
  return {
    enabled:
      section?.enabled === undefined
        ? DEFAULT_CONFIG.route.enabled
        : asBoolean(section.enabled, "route.enabled"),
    fallbackCrossDomainDocs:
      section?.fallbackCrossDomainDocs === undefined
        ? DEFAULT_CONFIG.route.fallbackCrossDomainDocs
        : asPositiveInt(section.fallbackCrossDomainDocs, "route.fallbackCrossDomainDocs", 0, 10),
    denyTags:
      section?.denyTags === undefined
        ? [...DEFAULT_CONFIG.route.denyTags]
        : asStringArray(section.denyTags, "route.denyTags"),
  };
}

function parseMaintenance(value: unknown): MemoryMdIndexConfig["maintenance"] {
  const section = asOptionalObject(value);
  return {
    enabled:
      section?.enabled === undefined
        ? DEFAULT_CONFIG.maintenance.enabled
        : asBoolean(section.enabled, "maintenance.enabled"),
    intervalMinutes:
      section?.intervalMinutes === undefined
        ? DEFAULT_CONFIG.maintenance.intervalMinutes
        : asPositiveInt(section.intervalMinutes, "maintenance.intervalMinutes", 5, 10_080),
    archiveAfterDays:
      section?.archiveAfterDays === undefined
        ? DEFAULT_CONFIG.maintenance.archiveAfterDays
        : asPositiveInt(section.archiveAfterDays, "maintenance.archiveAfterDays", 1, 365),
    dedupe:
      section?.dedupe === undefined
        ? DEFAULT_CONFIG.maintenance.dedupe
        : asBoolean(section.dedupe, "maintenance.dedupe"),
    weeklyEnabled:
      section?.weeklyEnabled === undefined
        ? DEFAULT_CONFIG.maintenance.weeklyEnabled
        : asBoolean(section.weeklyEnabled, "maintenance.weeklyEnabled"),
    weeklyWeekday:
      section?.weeklyWeekday === undefined
        ? DEFAULT_CONFIG.maintenance.weeklyWeekday
        : asPositiveInt(section.weeklyWeekday, "maintenance.weeklyWeekday", 0, 6),
  };
}

function parseLifecycle(value: unknown): MemoryMdIndexConfig["lifecycle"] {
  const section = asOptionalObject(value);
  return {
    enabled:
      section?.enabled === undefined
        ? DEFAULT_CONFIG.lifecycle.enabled
        : asBoolean(section.enabled, "lifecycle.enabled"),
    promoteThreshold:
      section?.promoteThreshold === undefined
        ? DEFAULT_CONFIG.lifecycle.promoteThreshold
        : asNumberInRange(section.promoteThreshold, "lifecycle.promoteThreshold", 0, 1),
    archiveThreshold:
      section?.archiveThreshold === undefined
        ? DEFAULT_CONFIG.lifecycle.archiveThreshold
        : asNumberInRange(section.archiveThreshold, "lifecycle.archiveThreshold", 0, 1),
    archiveInactiveDays:
      section?.archiveInactiveDays === undefined
        ? DEFAULT_CONFIG.lifecycle.archiveInactiveDays
        : asPositiveInt(section.archiveInactiveDays, "lifecycle.archiveInactiveDays", 1, 365),
  };
}

export const memoryMdIndexConfigSchema: OpenClawPluginConfigSchema = {
  parse(value: unknown): MemoryMdIndexConfig {
    if (value === undefined || value === null) {
      return {
        ...DEFAULT_CONFIG,
        retrieve: { ...DEFAULT_CONFIG.retrieve },
        route: { ...DEFAULT_CONFIG.route },
        writeback: { ...DEFAULT_CONFIG.writeback },
        maintenance: { ...DEFAULT_CONFIG.maintenance },
        lifecycle: { ...DEFAULT_CONFIG.lifecycle },
      };
    }

    const cfg = asObject(value, "memory-md-index config");
    return {
      rootDir:
        cfg.rootDir === undefined ? DEFAULT_CONFIG.rootDir : asString(cfg.rootDir, "rootDir"),
      retrieve: parseRetrieve(cfg.retrieve),
      route: parseRoute(cfg.route),
      writeback: parseWriteback(cfg.writeback),
      maintenance: parseMaintenance(cfg.maintenance),
      lifecycle: parseLifecycle(cfg.lifecycle),
      debug: cfg.debug === undefined ? DEFAULT_CONFIG.debug : asBoolean(cfg.debug, "debug"),
    };
  },
  uiHints: {
    rootDir: {
      label: "Memory Root Dir",
      help: "Workspace-relative directory for memory markdown files.",
      placeholder: DEFAULT_CONFIG.rootDir,
    },
    "retrieve.backend": {
      label: "Index Backend",
      help: "Retrieval backend: rg, bm25, or vector.",
      placeholder: DEFAULT_CONFIG.retrieve.backend,
    },
    "retrieve.topK": {
      label: "Top K",
      help: "Maximum memory snippets injected per run.",
      placeholder: String(DEFAULT_CONFIG.retrieve.topK),
    },
    "retrieve.maxChars": {
      label: "Max Inject Chars",
      help: "Hard cap for total injected prompt memory chars.",
      placeholder: String(DEFAULT_CONFIG.retrieve.maxChars),
      advanced: true,
    },
    "retrieve.rerank": {
      label: "Enable Rerank",
      help: "Apply post-retrieval reranking with recency/usage/confidence signals.",
      advanced: true,
    },
    "retrieve.rgCommand": {
      label: "RG Command",
      help: "Path or command name for ripgrep backend.",
      placeholder: DEFAULT_CONFIG.retrieve.rgCommand,
      advanced: true,
    },
    "retrieve.vectorCommand": {
      label: "Vector Command",
      help: "Optional external command for vector retrieval JSON API.",
      advanced: true,
    },
    "route.enabled": {
      label: "Enable Route Hints",
      help: "Infer memory routing hints and pre-filter retrieval candidates before search.",
      advanced: true,
    },
    "route.fallbackCrossDomainDocs": {
      label: "Cross-Domain Fallback",
      help: "Number of non-domain docs kept as fallback after route filtering.",
      placeholder: String(DEFAULT_CONFIG.route.fallbackCrossDomainDocs),
      advanced: true,
    },
    "route.denyTags": {
      label: "Route Deny Tags",
      help: "Entries tagged with these values are excluded from prompt recall.",
      advanced: true,
    },
    "writeback.enabled": {
      label: "Enable Writeback",
      help: "Write session outputs back to markdown memory files.",
    },
    "writeback.qualityGate": {
      label: "Writeback Quality Gate",
      help: "Writeback quality filter level: off, basic, strict.",
      placeholder: DEFAULT_CONFIG.writeback.qualityGate,
      advanced: true,
    },
    "writeback.proposalsEnabled": {
      label: "Enable Proposals",
      help: "Write rule candidates into memory/proposals for manual review.",
      advanced: true,
    },
    "maintenance.enabled": {
      label: "Enable Maintenance",
      help: "Run periodic memory maintenance tasks in plugin service.",
      advanced: true,
    },
    "maintenance.intervalMinutes": {
      label: "Maintenance Interval",
      help: "Periodic maintenance interval in minutes.",
      placeholder: String(DEFAULT_CONFIG.maintenance.intervalMinutes),
      advanced: true,
    },
    "maintenance.archiveAfterDays": {
      label: "Archive Age Days",
      help: "Move stale short-term memory files into archive after this many days.",
      placeholder: String(DEFAULT_CONFIG.maintenance.archiveAfterDays),
      advanced: true,
    },
    "maintenance.dedupe": {
      label: "Dedupe Mid Memory",
      help: "Remove duplicate entry blocks in mid memory files.",
      advanced: true,
    },
    "maintenance.weeklyEnabled": {
      label: "Enable Weekly Consolidate",
      help: "Run weekly rules consolidation and conflict report generation.",
      advanced: true,
    },
    "maintenance.weeklyWeekday": {
      label: "Weekly Run Day",
      help: "UTC weekday to run weekly consolidation (0=Sunday, 1=Monday, ...).",
      placeholder: String(DEFAULT_CONFIG.maintenance.weeklyWeekday),
      advanced: true,
    },
    "lifecycle.enabled": {
      label: "Enable Lifecycle",
      help: "Enable usage-based lifecycle scoring and decision logging.",
      advanced: true,
    },
    "lifecycle.promoteThreshold": {
      label: "Promote Threshold",
      help: "Score threshold for long-memory promotion candidate.",
      placeholder: String(DEFAULT_CONFIG.lifecycle.promoteThreshold),
      advanced: true,
    },
    "lifecycle.archiveThreshold": {
      label: "Archive Threshold",
      help: "Score threshold for archive candidate.",
      placeholder: String(DEFAULT_CONFIG.lifecycle.archiveThreshold),
      advanced: true,
    },
    "lifecycle.archiveInactiveDays": {
      label: "Archive Inactive Days",
      help: "Minimum inactive days before archive candidate is emitted.",
      placeholder: String(DEFAULT_CONFIG.lifecycle.archiveInactiveDays),
      advanced: true,
    },
    debug: {
      label: "Debug Logging",
      help: "Emit detailed plugin diagnostics to logs.",
      advanced: true,
    },
  },
};

export function getDefaultMemoryMdIndexConfig(): MemoryMdIndexConfig {
  return memoryMdIndexConfigSchema.parse(undefined) as MemoryMdIndexConfig;
}
