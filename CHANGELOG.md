# Changelog

## 0.2.0 - Unreleased

### Added
- Local-first MCP server for project/workspace-scoped debug memory.
- SQLite source-of-truth with recurring error signatures and occurrence tracking.
- User correction memory (`rejected_fix`, `project_preference`) and warning surfacing.
- Summary-first progressive retrieval and debug-aware ranking with explainable signals.
- Optional local embeddings and optional LanceDB indexing with graceful fallback.
- Safe search/replace patching with snapshots and restore support.
- Structured command runner with task budgets and deterministic workflow tools.
- Local dashboard for memory/search/recurring errors/user corrections/task history.
- Retrieval evaluation harness and phase checks.
- MCP client integration docs, examples, and first-run doctor script.

### Changed
- Monorepo/workspace scoping hardened with explicit `workspace_path` handling.
- Dashboard API and UX improved for memory management and local operations.
- Documentation updated for product-level usage and integration templates.

### Fixed
- Package/docs path consistency and absolute local path cleanup.
- Dashboard instruction templates now load from Bugrecall package root.

### Known limitations
- Package remains private in this phase; npm publish is intentionally disabled.
- Vector search is optional and may be unavailable on some environments.
- First embedding model load can be slow on cold start.
