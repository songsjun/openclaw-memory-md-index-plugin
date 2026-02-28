# OpenClaw Memory MD Index Plugin

`memory-md-index` is an OpenClaw plugin that adds pluggable markdown memory retrieval and writeback.

## Features

- Prompt injection before model call (`mutate_prompt`)
- Post-run memory writeback (`after_run`)
- Optional routing hints (`before_route`)
- Pluggable retrieval backend (`rg` / `bm25` / `vector`)
- Maintenance hooks for archive/dedupe/consolidation

## Files

- `index.ts`: plugin entry and hook registration
- `config.ts`: config schema and defaults
- `indexer.ts`: retrieval backend implementation
- `writeback.ts`: memory writeback and summaries
- `routing.ts`: route hints and denylist filtering
- `maintenance.ts`: periodic maintenance logic
- `lifecycle.ts`: promotion/archive by hit/success signals

## Install

Copy this plugin directory into your OpenClaw `extensions/` directory and add it to plugin config.

## Development

This repository is extracted from OpenClaw extension sources and keeps tests for regression coverage.
