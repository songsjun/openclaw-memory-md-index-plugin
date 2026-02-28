import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { memoryMdIndexConfigSchema } from "./config.js";
import { runEvaluation } from "./evaluation.js";
import { createMemoryIndexBackend } from "./indexer.js";
import { appendUsageEvent } from "./lifecycle.js";
import type { MemoryMaintenanceMode } from "./maintenance.js";
import { runMemoryMaintenance } from "./maintenance.js";
import { buildMemoryPromptBlock } from "./prompt.js";
import { rerankMemoryHits } from "./rerank.js";
import { filterDocumentsForRouting, inferRoutingHints } from "./routing.js";
import { MarkdownMemoryStore } from "./store.js";
import { writeRunMemory } from "./writeback.js";

function resolveWorkspaceDir(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : process.cwd();
}

const memoryMdIndexPlugin = {
  id: "memory-md-index",
  name: "Memory (Markdown Index)",
  description: "Markdown-backed memory plugin with pluggable retrieval backends",
  kind: "memory",
  configSchema: memoryMdIndexConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = memoryMdIndexConfigSchema.parse(api.pluginConfig);
    const indexBackend = createMemoryIndexBackend({
      config: cfg,
      logger: { warn: api.logger.warn },
    });
    const sessionInjectedHits = new Map<string, string[]>();
    let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
    const createStore = (workspaceDir: string) =>
      new MarkdownMemoryStore({
        workspaceDir,
        rootDir: cfg.rootDir,
        sessionStateFile: cfg.writeback.sessionStateFile,
        midDir: cfg.writeback.midDir,
      });
    const runMaintenanceForWorkspace = async (
      workspaceDir: string,
      mode?: MemoryMaintenanceMode,
    ) => {
      const store = createStore(workspaceDir);
      return runMemoryMaintenance({
        store,
        config: cfg,
        logger: { info: api.logger.info, warn: api.logger.warn },
        mode,
      });
    };

    // Keep memory_search/memory_get tools available when this plugin is selected.
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );
    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );

    api.on("before_prompt_build", async (event, ctx) => {
      const query = event.prompt?.trim();
      if (!query) {
        return;
      }

      const workspaceDir = resolveWorkspaceDir(ctx.workspaceDir);
      const store = createStore(workspaceDir);
      const layout = store.getLayout();
      const docs = await store.listDocuments({
        includePaths: cfg.retrieve.includePaths,
        excludePaths: cfg.retrieve.excludePaths,
      });
      if (docs.length === 0) {
        return;
      }

      const routeHints = inferRoutingHints({
        query,
        denyTags: cfg.route.enabled ? cfg.route.denyTags : [],
      });
      const filtered = cfg.route.enabled
        ? filterDocumentsForRouting({
            docs,
            hints: routeHints,
            fallbackCrossDomainDocs: cfg.route.fallbackCrossDomainDocs,
          })
        : {
            filteredDocs: docs,
            rejectedCount: 0,
            fallbackCount: 0,
          };
      if (filtered.filteredDocs.length === 0) {
        if (cfg.debug) {
          api.logger.info(
            `memory-md-index: route filtered all docs domain=${routeHints.domain} rejected=${filtered.rejectedCount}`,
          );
        }
        return;
      }

      const baseHits = await indexBackend.search({
        query,
        topK: cfg.retrieve.topK,
        docs: filtered.filteredDocs,
        memoryRootDir: layout.rootDir,
      });
      const reranked = cfg.retrieve.rerank
        ? rerankMemoryHits({
            hits: baseHits,
            docs: filtered.filteredDocs,
          })
        : { hits: baseHits, details: [] };
      const hits = reranked.hits.slice(0, cfg.retrieve.topK);
      if (cfg.lifecycle.enabled) {
        const ts = new Date().toISOString();
        for (const hit of baseHits) {
          await appendUsageEvent({
            rootDir: layout.rootDir,
            event: {
              ts,
              type: "retrieve_hit",
              sessionId: ctx.sessionId,
              agentId: ctx.agentId,
              query,
              relativePath: hit.relativePath,
            },
          }).catch((error) => {
            api.logger.warn(`memory-md-index: usage retrieve event failed: ${String(error)}`);
          });
        }
      }
      const memoryBlock = buildMemoryPromptBlock({
        backend: indexBackend.name,
        hits,
        maxChars: cfg.retrieve.maxChars,
      });
      if (!memoryBlock) {
        return;
      }

      if (cfg.debug) {
        const topRerank = reranked.details
          .slice(0, 3)
          .map(
            (detail) =>
              `${detail.relativePath} final=${detail.final.toFixed(3)} lexical=${detail.lexical.toFixed(3)} recency=${detail.recency.toFixed(3)} usage=${detail.usage.toFixed(3)} confidence=${detail.confidence.toFixed(3)}`,
          )
          .join("; ");
        api.logger.info(
          `memory-md-index: injected ${memoryBlock.sources.length} memory hits (${indexBackend.name}) domain=${routeHints.domain} rejectedDocs=${filtered.rejectedCount} fallbackDocs=${filtered.fallbackCount}${topRerank ? ` rerank=[${topRerank}]` : ""}`,
        );
      }

      if (cfg.lifecycle.enabled) {
        const ts = new Date().toISOString();
        const sessionId = ctx.sessionId ?? ctx.sessionKey;
        const injectedPaths = hits.map((hit) => hit.relativePath);
        if (sessionId) {
          sessionInjectedHits.set(sessionId, injectedPaths);
        }
        for (const relativePath of injectedPaths) {
          await appendUsageEvent({
            rootDir: layout.rootDir,
            event: {
              ts,
              type: "prompt_injected",
              sessionId: ctx.sessionId,
              agentId: ctx.agentId,
              query,
              relativePath,
            },
          }).catch((error) => {
            api.logger.warn(`memory-md-index: usage inject event failed: ${String(error)}`);
          });
        }
      }

      return {
        prependContext: memoryBlock.block,
      };
    });

    api.on("agent_end", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx.workspaceDir);
      const store = createStore(workspaceDir);
      const layout = store.getLayout();
      const sessionId = ctx.sessionId ?? ctx.sessionKey;
      const injectedPaths = sessionId ? (sessionInjectedHits.get(sessionId) ?? []) : [];

      if (cfg.lifecycle.enabled && injectedPaths.length > 0) {
        const ts = new Date().toISOString();
        for (const relativePath of injectedPaths) {
          await appendUsageEvent({
            rootDir: layout.rootDir,
            event: {
              ts,
              type: "task_outcome",
              sessionId: ctx.sessionId,
              agentId: ctx.agentId,
              relativePath,
              success: event.success,
            },
          }).catch((error) => {
            api.logger.warn(`memory-md-index: usage outcome event failed: ${String(error)}`);
          });
        }
      }
      if (sessionId) {
        sessionInjectedHits.delete(sessionId);
      }

      try {
        await writeRunMemory({
          store,
          config: cfg,
          event,
          ctx,
          logger: { info: api.logger.info, warn: api.logger.warn },
        });
      } catch (error) {
        api.logger.warn(`memory-md-index: writeback failed: ${String(error)}`);
      }
    });

    api.registerService({
      id: "memory-md-index-maintenance",
      start: async (serviceCtx) => {
        if (!cfg.maintenance.enabled) {
          return;
        }
        const workspaceDir = resolveWorkspaceDir(serviceCtx.workspaceDir);
        await runMaintenanceForWorkspace(workspaceDir, "auto").catch((error) => {
          api.logger.warn(`memory-md-index: maintenance run failed: ${String(error)}`);
        });

        maintenanceTimer = setInterval(
          () => {
            void runMaintenanceForWorkspace(workspaceDir, "auto").catch((error) => {
              api.logger.warn(`memory-md-index: maintenance run failed: ${String(error)}`);
            });
          },
          cfg.maintenance.intervalMinutes * 60 * 1000,
        );
        maintenanceTimer.unref?.();
      },
      stop: async () => {
        if (maintenanceTimer) {
          clearInterval(maintenanceTimer);
          maintenanceTimer = null;
        }
      },
    });

    api.registerCli(
      ({ program, workspaceDir, logger }) => {
        const memory = program
          .command("memory-md-index")
          .description("memory-md-index plugin commands");
        memory
          .command("maintain")
          .description("Run one maintenance pass (daily/weekly/auto).")
          .option("--mode <mode>", "maintenance mode: auto|daily|weekly", "auto")
          .action(async (opts: { mode?: string }) => {
            const modeRaw = opts.mode?.trim().toLowerCase() ?? "auto";
            const mode: MemoryMaintenanceMode =
              modeRaw === "daily" || modeRaw === "weekly" || modeRaw === "auto" ? modeRaw : "auto";
            const targetWorkspace = resolveWorkspaceDir(workspaceDir);
            const result = await runMaintenanceForWorkspace(targetWorkspace, mode);
            logger.info(
              `memory-md-index: maintain done mode=${result.mode} archivedSessionState=${result.archivedSessionState} dedupedFiles=${result.dedupedFiles} removedDuplicateBlocks=${result.removedDuplicateBlocks} promoteCandidates=${result.promoteCandidates} archiveCandidates=${result.archiveCandidates} weeklyConsolidatedRules=${result.weeklyConsolidatedRules} weeklyConflictPairs=${result.weeklyConflictPairs} dailyReportPath=${result.dailyReportPath}${result.weeklyReportPath ? ` weeklyReportPath=${result.weeklyReportPath}` : ""}${result.weeklyProposalPath ? ` weeklyProposalPath=${result.weeklyProposalPath}` : ""}`,
            );
          });

        memory
          .command("evaluate")
          .description("Run A/B evaluation and gate checks from JSONL records.")
          .requiredOption("--input <path>", "Path to evaluation JSONL records")
          .option("--output <path>", "Path to markdown report output")
          .action(async (opts: { input: string; output?: string }) => {
            const targetWorkspace = resolveWorkspaceDir(workspaceDir);
            const defaultOutput = path.join(
              targetWorkspace,
              cfg.rootDir,
              "reports",
              `evaluation_${new Date().toISOString().slice(0, 10)}.md`,
            );
            const result = await runEvaluation({
              inputPath: opts.input,
              outputPath: opts.output ?? defaultOutput,
            });
            logger.info(
              `memory-md-index: evaluation done gate=${result.summary.gate.go ? "GO" : "NO_GO"} outputPath=${result.outputPath}`,
            );
          });
      },
      { commands: ["memory-md-index"] },
    );
  },
};

export default memoryMdIndexPlugin;
