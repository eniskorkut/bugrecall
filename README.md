# Bugrecall

Local-first debug memory for AI coding agents.

Bugrecall is a local MCP server that helps coding agents remember project-specific debugging experience: recurring errors, verified fixes, rejected fix strategies, and user corrections.

## What is Bugrecall?

Bugrecall is not a general memory assistant. It is a project/workspace-scoped debug memory layer for coding workflows. It integrates through MCP tools, stores data locally, and helps agents avoid repeating the same mistakes in the same codebase.

## What problems does it solve?

- Repeated terminal/test/build/type errors.
- Agents forgetting previous fixes.
- Agents repeating user-rejected fix strategies.
- Monorepo workspace confusion.
- Context noise from dumping full historical memory into prompts.

## Core concepts

- Project identity: deterministic ID based on repo identity + workspace-relative path + manifest fingerprint.
- Workspace path: optional `workspace_path` to target `apps/web`, `services/api`, etc.
- Memory records: local SQLite records for incidents/facts/decisions and user corrections.
- Verified fix: memory written after successful validation/finalization.
- User correction / rejected fix: explicit user preference or rejected strategy.
- Error signature: deterministic fingerprint of normalized error.
- Recurring error: same signature seen multiple times.
- Progressive retrieval: summary-first search, full detail on demand.
- Retrieval evaluation: deterministic quality harness for ranking behavior.

## Features

- MCP stdio server (stdout reserved for MCP protocol).
- Dashboard on `http://127.0.0.1:1453`.
- SQLite source-of-truth memory store.
- Optional local embeddings.
- Optional LanceDB vector index.
- Terminal/test/type/syntax error normalization.
- Error signatures + recurring errors.
- Debug sessions and structured workflow tools.
- Safe search/replace patching + snapshots.
- Structured command runner with budget controls.
- User correction memory (`rejected_fix`, `project_preference`).
- Summary-first retrieval with ranking breakdown.
- Retrieval evaluation harness.

## Requirements

- Node.js 22 recommended. Node.js 20 may work.
- `npm`.
- Git repo recommended for stable identity.
- Optional internet on first embedding model download if embeddings are enabled.
- Docker not required.

## Install from source

```bash
git clone https://github.com/eniskorkut/bugrecall.git
cd bugrecall/project-memory-agent
npm install
npm run build
npm run typecheck
```

## First-run check

```bash
npm run build
npm run doctor
```

## Run MCP server

```bash
node bin/pma.js
```

Notes:
- `stdout` is reserved for MCP protocol.
- Logs go to `stderr`.
- Usually your MCP client starts this command automatically.

## Run dashboard

```bash
node bin/pma.js dashboard
```

Open:
- `http://127.0.0.1:1453`

Notes:
- Dashboard is local-only.
- Opening `file://.../index.html` directly will not work for API calls.

## First project bootstrap

In your target project directory:

```bash
cd /path/to/my-other-project
```

Then configure your MCP client to run Bugrecall from your Bugrecall clone path (`node /absolute/path/to/bugrecall/project-memory-agent/bin/pma.js`).

Bugrecall resolves identity from `cwd` plus optional `workspace_path`. In monorepos, pass `workspace_path` such as `apps/web` or `packages/api`.

## Dogfood workflow (another project)

1. Connect Bugrecall MCP server to your coding agent.
2. Call `bootstrap_project`.
3. On failures, call `ingest_terminal_error` or `record_error_observation`.
4. Call `search_project_experience` before patching.
5. After successful validation, call `finalize_successful_fix`.
6. If a strategy is rejected, call `record_user_correction`.
7. Review in dashboard: memories, recurring errors, user corrections, task runs.

Example prompts:
- "Use Bugrecall. Bootstrap this project, run the test command through Bugrecall if available, ingest any terminal errors, search project experience before patching, and finalize the fix only after tests pass."
- "Record this correction in Bugrecall: do not solve this TypeScript error with any casts; fix the actual shared type."

## MCP tools overview

| Category | Tools |
|---|---|
| Project | `health_check`, `bootstrap_project`, `get_project_profile` |
| Memory | `commit_postmortem`, `read_project_memory`, `search_project_experience`, `get_memory_detail`, `record_user_correction`, `list_user_corrections` |
| Errors | `ingest_terminal_error`, `get_recurring_errors` |
| Debug workflow | `create_debug_session`, `record_error_observation`, `suggest_next_actions`, `finalize_successful_fix`, `fail_debug_session` |
| Commands | `start_task_run`, `run_project_command`, `log_attempt`, `get_task_run` |
| Patch/snapshot | `apply_search_replace_patch`, `restore_snapshot` |
| Vector/index | `vectorize_pending_memories`, `get_vectorization_status`, `index_ready_memories` |

## MCP client config examples

See:
- [docs/mcp-clients.md](/Users/eniskorkut/Desktop/bugrecall/project-memory-agent/docs/mcp-clients.md)
- [examples/mcp-config.generic.json](/Users/eniskorkut/Desktop/bugrecall/project-memory-agent/examples/mcp-config.generic.json)

Generic template:

```json
{
  "mcpServers": {
    "bugrecall": {
      "command": "node",
      "args": ["/absolute/path/to/bugrecall/project-memory-agent/bin/pma.js"]
    }
  }
}
```

Codex/Claude/Cursor config UIs and file paths vary by version. Use the same stdio command and adapt to your client.

## Local data and privacy

- Data is local under `.agent/` at repo root.
- SQLite DB: `.agent/memory.db`.
- Vector index (if enabled): `.agent/lancedb`.
- Add `.agent/` to `.gitignore` and do not commit it.
- Bugrecall stores normalized error/signature data, not full raw terminal logs by default.
- User corrections are local.
- No cloud sync by default.

More: [docs/local-data.md](/Users/eniskorkut/Desktop/bugrecall/project-memory-agent/docs/local-data.md)

## Embeddings and env vars

- `BUGRECALL_EMBEDDINGS=on|off` (default: `on`)
- `BUGRECALL_EMBEDDING_MODEL` (default: `Xenova/all-MiniLM-L6-v2`)
- `BUGRECALL_EMBEDDING_TIMEOUT_MS` (default: `30000`)
- `BUGRECALL_MAX_VECTORIZATION_BATCH` (default: `10`)
- `BUGRECALL_DASHBOARD_HOST` (default: `127.0.0.1`)
- `BUGRECALL_DASHBOARD_PORT` (default: `1453`)
- `BUGRECALL_DASHBOARD_ALLOW_REMOTE=1` to allow non-local host binding

First model load may be slow. Search still works with SQLite text fallback.

## Evaluation

```bash
npm run eval:retrieval
```

Reported metrics:
- `top1_accuracy`
- `top3_recall`
- `mrr`
- `warning_recall`
- `false_positive_count`

## Development checks

```bash
npm run build
npm run typecheck
npm run phase11d:check
npm run phase12a:check
npm run phase12b:check
npm run phase12c:check
npm run phase12d:check
npm run phase12e:check
npm run eval:retrieval
npm run phase13a:check
```

## Known limitations

- Bugrecall is not a fully autonomous coding agent.
- It does not internally generate patches with an LLM.
- Vector search is optional.
- Dashboard is local tool UI, not an auth-protected multi-user app.
- MCP client setup differs by tool/version.
- First embedding load can be slow.
- Quality depends on agents using the right tool sequence.
- Users should review patches and memory entries.

## Roadmap (short)

- More MCP client integration guides.
- npm package readiness.
- Better dashboard editing flows.
- More real-world retrieval fixtures.
- Import/export.
- Memory pruning.
- CI hardening.
