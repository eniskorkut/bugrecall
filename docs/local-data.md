# Local Data, Privacy, and Safety

## Storage layout

- SQLite source-of-truth:
  - `.agent/memory.db`
- Optional vector index:
  - `.agent/lancedb/`

`.agent/` is created under repository root.

## Git hygiene

- Add `.agent/` to `.gitignore`.
- Do not commit `.agent/`.

## Privacy

- Bugrecall is local-first.
- No cloud sync by default.
- User corrections and memory records stay local unless you export manually.

## Error/log storage

- Bugrecall stores normalized errors and signatures.
- Full raw terminal logs are not intended to be stored fully by default.

## Dashboard exposure

- Dashboard default host: `127.0.0.1`
- Dashboard default port: `1453`
- Remote bind blocked unless `BUGRECALL_DASHBOARD_ALLOW_REMOTE=1`
- Dashboard export (`/api/export`) returns local JSON for current project/workspace.

## Command safety model

- No arbitrary user-provided shell command execution through MCP tools.
- Structured command kinds only (`test`, `lint`, `build`, `typecheck`).
- `spawn(..., shell: false)` path used for command execution.
- Optional command overrides:
  - Local user config: `.agent/bugrecall.config.json`
  - Optional committed config: `bugrecall.config.json`
- Override commands must be JSON arrays of strings, not shell strings.
- Unsafe executables/tokens are ignored with warnings.

## Patch safety model

- Search/replace patch requires exact unique match.
- Snapshot captured before successful patch writes.
- Restore is project/workspace-isolated.

## Deletion behavior

- Dashboard/API deletion removes matching `memory_records` rows in current project/workspace scope.
- If a signature was linked to deleted memory, `error_signatures.linked_memory_id` is cleared.
- Task/patch/snapshot history is not fully purged in this phase.
