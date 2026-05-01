# Integration Troubleshooting

## MCP client cannot start server

1. Run `npm run build`.
2. Use absolute path: `/absolute/path/to/bugrecall/bin/pma.js`.
3. Check Node version.
4. Run `npm run doctor`.

## Dashboard opens but data is missing

- Dashboard is separate from MCP client process.
- Current `cwd` / project context matters.
- `workspace_path` matters for monorepos.

## `file://` dashboard issue

Do not open static files directly. Run:

```bash
node bin/pma.js dashboard
```

Then open `http://127.0.0.1:1453`.

## No memories found

- Call `bootstrap_project` first.
- Verified memories appear after `finalize_successful_fix` or `commit_postmortem`.
- User correction memories appear after `record_user_correction`.
- Terminal ingestion writes signatures/occurrences, not verified memory by default.

## Embeddings feel slow

- First model load can be slow.
- Text fallback retrieval still works.
- You can disable embeddings with `BUGRECALL_EMBEDDINGS=off`.

## Monorepo confusion

- Pass `workspace_path` consistently for all relevant tools.

## Sandbox / EPERM listen during checks

In restricted environments, `phase9b` / `phase10` may fail with `EPERM listen` due to local IPC/socket limits. Treat this as environment limitation unless reproducible outside sandbox.
