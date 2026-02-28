# OpenClaw Memory MD Index Plugin

`memory-md-index` is a minimal-invasive OpenClaw memory plugin.

It keeps markdown files as the source of truth, injects relevant memory before model calls, and writes back task outcomes after runs. Retrieval backend can be switched between `rg`, `bm25`, and `vector` without changing core OpenClaw logic.

## What this plugin does

- Inject memory context before prompt build (`before_prompt_build` hook)
- Write back session outcomes after run (`agent_end` hook)
- Provide routing hints + deny-tag filtering before retrieval
- Support pluggable retrieval backends (`rg` / `bm25` / `vector`)
- Run maintenance (archive/dedupe/weekly consolidation)
- Track usage/outcome signals for promotion/archive lifecycle

## Design principles

1. Core untouched: OpenClaw core flow is unchanged; all behavior comes from plugin hooks.
2. Markdown first: markdown files are authoritative data; index/retrieval is replaceable execution detail.
3. Replaceable backend: host only depends on `retrieve + writeback` behavior, not a fixed index engine.
4. Bounded injection: `topK` and `maxChars` hard-limit prompt payload.
5. Safe evolution: operational changes go to `memory/proposals/*` first, avoid auto-mutating skills.

## Runtime flow

1. `before_prompt_build`
- Read memory docs from `memory/` (configurable `rootDir`)
- Apply route hints and deny-tag filtering
- Retrieve + optional rerank
- Inject one bounded memory block into context

2. `agent_end`
- Summarize run outcome and write markdown memory
- Update lifecycle usage signals (hit, injected, task outcome)

3. Maintenance service / CLI
- Periodic archive + dedupe + weekly consolidation
- Emit maintenance and evaluation reports under `memory/reports/`

## Suggested memory layout

```text
memory/
  short/session_state.md
  mid/*.md
  long/rules.md
  archive/
  proposals/
  reports/
```

## Install and enable

1. Put this repository in an OpenClaw-readable plugin path.
2. Enable it in OpenClaw config and set memory slot to this plugin.

Example (`openclaw.json` / json5 style):

```json5
{
  plugins: {
    load: {
      paths: ["/absolute/path/openclaw-memory-md-index-plugin"],
    },
    slots: {
      memory: "memory-md-index",
    },
    entries: {
      "memory-md-index": {
        enabled: true,
        config: {
          rootDir: "memory",
          retrieve: {
            backend: "rg",
            topK: 5,
            maxChars: 3200,
            rerank: true,
          },
          route: {
            enabled: true,
            denyTags: ["do_not_recall"],
          },
          writeback: {
            enabled: true,
            sessionStateFile: "short/session_state.md",
            midDir: "mid",
            qualityGate: "basic",
            proposalsEnabled: true,
          },
          maintenance: {
            enabled: true,
            intervalMinutes: 1440,
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
        },
      },
    },
  },
}
```

## External dependencies

- Required:
  - Node.js runtime supported by OpenClaw
  - OpenClaw with plugin system enabled
- Optional:
  - `rg` (ripgrep) for `retrieve.backend = "rg"` (default command: `rg`)
  - External vector retriever command for `retrieve.backend = "vector"` (`retrieve.vectorCommand`)
  - Cron/system scheduler if you prefer external periodic maintenance over in-process service timer

## Test and verification

Use OpenClaw monorepo test runner (plugin tests are colocated there):

```bash
corepack pnpm test -- extensions/memory-md-index/*.test.ts
```

Quick runtime smoke checks:

1. Prompt injection
- Enable `debug: true`
- Run one query
- Verify logs contain `memory-md-index: injected ... memory hits`

2. Writeback
- Complete one task
- Verify `memory/short/session_state.md` updated
- Verify `memory/mid/*.md` appended when writeback rules match

3. Maintenance
- Run:

```bash
openclaw memory-md-index maintain --mode daily
```

- Verify report file in `memory/reports/`

4. Evaluation gate (A/B records JSONL)

```bash
openclaw memory-md-index evaluate --input /path/to/eval.jsonl
```

- Verify markdown report is generated with GO/NO_GO summary

## Operations and management

- Daily:
  - Review `memory/reports/*daily*.md`
  - Check archive/dedupe counts and anomaly logs
- Weekly:
  - Review `memory/reports/*weekly*.md`
  - Manually inspect `memory/proposals/*` before changing skills/rules
- Incident rollback:
  - Set `plugins.slots.memory = "none"` or disable `memory-md-index` entry
  - Plugin-off behavior returns to baseline OpenClaw prompt/writeback path

## Security notes

- Do not commit real API keys or tokens in repository/config examples.
- Use environment variables or secure host-level secret stores for provider credentials.
- Keep `memory/` under access-controlled workspace; treat it as user data.
