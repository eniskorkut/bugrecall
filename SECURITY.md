# Security Policy

## Scope

Bugrecall is a local-first developer tool. It stores memory data in local project storage and does not provide built-in cloud sync.

## Security model (high level)

- SQLite is source-of-truth under local `.agent/` storage.
- Dashboard is local-only (`127.0.0.1` by default), not a multi-user authenticated web app.
- Command execution is constrained to structured command kinds (`test`, `lint`, `build`, `typecheck`), not arbitrary shell input.
- Patch application uses exact+unique search/replace safety checks and pre-write snapshots.

## Data handling guidance

- Do not store secrets, credentials, or private keys in memory content.
- `.agent/` should stay gitignored and should not be committed.
- Normalized error/signature data is stored for debugging; full raw logs are not intended to be stored by default.

## Reporting security issues

Please report security issues via:
- GitHub issues: <https://github.com/eniskorkut/bugrecall/issues>

If a private reporting channel is needed later, this policy can be updated.
