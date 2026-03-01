import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import memoryMdIndexPlugin from "./index.js";

function createMockApi(params: {
  pluginConfig: Record<string, unknown>;
  hookHandlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
}) {
  const registerTool = vi.fn();
  const registerCli = vi.fn();
  const registerService = vi.fn();
  const api = {
    pluginConfig: params.pluginConfig,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      tools: {
        createMemorySearchTool: vi.fn(),
        createMemoryGetTool: vi.fn(),
        registerMemoryCli: vi.fn(),
      },
    },
    registerTool,
    registerCli,
    registerService,
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      params.hookHandlers[hookName] ??= [];
      params.hookHandlers[hookName].push(handler);
    },
  } as unknown as OpenClawPluginApi;
  return { api, registerTool, registerCli, registerService };
}

describe("memory-md-index plugin hook wiring", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-md-index-plugin-"));
    await fs.mkdir(path.join(workspaceDir, "memory/mid"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory/mid/2026-02-24.md"),
      "We use plugin hooks to inject memory context before model call.",
      "utf8",
    );
  });

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("registers before_prompt_build and injects memory block", async () => {
    const hookHandlers: Record<
      string,
      Array<(event: unknown, ctx: unknown) => Promise<unknown>>
    > = {};
    const { api, registerTool, registerCli, registerService } = createMockApi({
      hookHandlers,
      pluginConfig: {
        rootDir: "memory",
        retrieve: {
          backend: "bm25",
          topK: 3,
          maxChars: 800,
          includePaths: ["mid"],
          excludePaths: [],
        },
      },
    });

    await memoryMdIndexPlugin.register(api);

    const handler = hookHandlers.before_prompt_build?.[0];
    expect(handler).toBeDefined();

    const result = await handler?.(
      { prompt: "inject memory context", messages: [] },
      { workspaceDir, sessionId: "sid-1" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("<memory-context>"),
      }),
    );
    expect(String((result as { prependContext: string }).prependContext)).toContain(
      "mid/2026-02-24.md",
    );
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerCli).toHaveBeenCalledTimes(2);
    expect(registerService).toHaveBeenCalledTimes(1);
  });

  it("registers agent_end writeback hook", async () => {
    const hookHandlers: Record<
      string,
      Array<(event: unknown, ctx: unknown) => Promise<unknown>>
    > = {};
    const { api } = createMockApi({
      hookHandlers,
      pluginConfig: {
        rootDir: "memory",
        retrieve: {
          backend: "bm25",
          topK: 3,
          maxChars: 800,
          includePaths: ["mid"],
          excludePaths: [],
        },
      },
    });

    await memoryMdIndexPlugin.register(api);
    const handler = hookHandlers.agent_end?.[0];
    expect(handler).toBeDefined();

    await handler?.(
      {
        success: true,
        messages: [
          { role: "user", content: "Please keep memory in markdown files." },
          { role: "assistant", content: "Decision: Keep markdown as source of truth." },
        ],
      },
      { workspaceDir, sessionId: "sid-2", agentId: "main" },
    );

    const sessionState = await fs.readFile(
      path.join(workspaceDir, "memory/short/session_state.md"),
      "utf8",
    );
    expect(sessionState).toContain("Please keep memory in markdown files.");
  });

  it("applies route filtering before retrieval", async () => {
    const routeWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-memory-md-index-route-filter-"),
    );
    await fs.mkdir(path.join(routeWorkspace, "memory/mid/programming"), { recursive: true });
    await fs.mkdir(path.join(routeWorkspace, "memory/mid/people"), { recursive: true });
    await fs.writeFile(
      path.join(routeWorkspace, "memory/mid/programming/2026-02-24.md"),
      "Plugin bug fix checklist for node runtime.",
      "utf8",
    );
    await fs.writeFile(
      path.join(routeWorkspace, "memory/mid/people/2026-02-24.md"),
      "A bug is an insect in biology.",
      "utf8",
    );

    const hookHandlers: Record<
      string,
      Array<(event: unknown, ctx: unknown) => Promise<unknown>>
    > = {};
    const { api } = createMockApi({
      hookHandlers,
      pluginConfig: {
        rootDir: "memory",
        retrieve: {
          backend: "bm25",
          topK: 1,
          maxChars: 800,
          includePaths: ["mid"],
          excludePaths: [],
        },
        route: {
          enabled: true,
          fallbackCrossDomainDocs: 0,
          denyTags: ["do_not_recall"],
        },
      },
    });

    try {
      await memoryMdIndexPlugin.register(api);
      const handler = hookHandlers.before_prompt_build?.[0];
      expect(handler).toBeDefined();

      const result = await handler?.(
        { prompt: "Fix plugin bug in node runtime", messages: [] },
        { workspaceDir: routeWorkspace, sessionId: "sid-route-1" },
      );
      const prepend = String((result as { prependContext?: string }).prependContext ?? "");
      expect(prepend).toContain("mid/programming/2026-02-24.md");
      expect(prepend).not.toContain("mid/people/2026-02-24.md");
    } finally {
      await fs.rm(routeWorkspace, { recursive: true, force: true });
    }
  });

  it("tracks lifecycle events for priority-injected long docs", async () => {
    const priorityWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-memory-md-index-priority-events-"),
    );
    await fs.mkdir(path.join(priorityWorkspace, "memory/long"), { recursive: true });
    await fs.mkdir(path.join(priorityWorkspace, "memory/mid/programming"), { recursive: true });
    await fs.writeFile(
      path.join(priorityWorkspace, "memory/long/rules.md"),
      "Always keep TypeScript strict mode enabled for repository safety.",
      "utf8",
    );
    await fs.writeFile(
      path.join(priorityWorkspace, "memory/mid/programming/2026-02-28.md"),
      "Today we enabled TypeScript strict mode in tsconfig.",
      "utf8",
    );

    const hookHandlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> =
      {};
    const { api } = createMockApi({
      hookHandlers,
      pluginConfig: {
        rootDir: "memory",
        retrieve: {
          backend: "bm25",
          topK: 3,
          maxChars: 1200,
          priorityInjection: true,
          includePaths: ["long", "mid"],
          excludePaths: [],
        },
        lifecycle: {
          enabled: true,
          promoteThreshold: 0.75,
          archiveThreshold: 0.35,
          archiveInactiveDays: 30,
        },
      },
    });

    try {
      await memoryMdIndexPlugin.register(api);
      const promptHandler = hookHandlers.before_prompt_build?.[0];
      const endHandler = hookHandlers.agent_end?.[0];
      expect(promptHandler).toBeDefined();
      expect(endHandler).toBeDefined();

      const sessionCtx = {
        workspaceDir: priorityWorkspace,
        sessionId: "sid-priority-1",
        agentId: "main",
      };
      const promptResult = await promptHandler?.(
        { prompt: "Enable TypeScript strict mode", messages: [] },
        sessionCtx,
      );
      const prepend = String((promptResult as { prependContext?: string }).prependContext ?? "");
      expect(prepend).toContain("long/rules.md");
      expect(prepend).toContain("mid/programming/2026-02-28.md");

      await endHandler?.(
        {
          success: true,
          messages: [
            { role: "user", content: "Enable strict mode" },
            { role: "assistant", content: "Done" },
          ],
        },
        sessionCtx,
      );

      const usagePath = path.join(priorityWorkspace, "memory/meta/usage.jsonl");
      const usageContent = await fs.readFile(usagePath, "utf8");
      const events = usageContent
        .split("\n")
        .filter((row) => row.trim().length > 0)
        .map((row) => JSON.parse(row) as { type: string; sessionId?: string; relativePath?: string });
      const bySession = events.filter((event) => event.sessionId === "sid-priority-1");

      const promptInjectedPaths = new Set(
        bySession
          .filter((event) => event.type === "prompt_injected")
          .map((event) => event.relativePath),
      );
      const taskOutcomePaths = new Set(
        bySession.filter((event) => event.type === "task_outcome").map((event) => event.relativePath),
      );

      expect(promptInjectedPaths.has("long/rules.md")).toBe(true);
      expect(promptInjectedPaths.has("mid/programming/2026-02-28.md")).toBe(true);
      expect(taskOutcomePaths.has("long/rules.md")).toBe(true);
      expect(taskOutcomePaths.has("mid/programming/2026-02-28.md")).toBe(true);
    } finally {
      await fs.rm(priorityWorkspace, { recursive: true, force: true });
    }
  });
});
