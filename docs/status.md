# Bugrecall MVP Status

## Current status

- Bugrecall is MVP-ready for local dogfooding.
- Package remains private.
- Not yet published to npm.
- Recommended install path is source clone for now.

## What works

- MCP stdio server
- Local dashboard
- Project/workspace scoped memory
- Terminal error ingestion and normalization
- Error signatures
- Recurring errors
- Verified fix memory
- Rejected fix / user correction memory
- Progressive retrieval
- Ranking reasons and score breakdown
- Retrieval evaluation harness
- Package dry-run validation

## What does not exist yet

- Cloud sync
- Multi-user dashboard authentication
- npm published package
- Automatic LLM patch generation inside Bugrecall
- Guaranteed support for every MCP client config format
- Memory pruning
- Full import/restore workflow beyond JSON export

## Recommended first dogfood scenario

1. Clone and build Bugrecall.
2. Connect Bugrecall to Codex/Cursor/Claude.
3. Open a real project.
4. Ask the agent to bootstrap Bugrecall.
5. Trigger a real type/test/build error.
6. Search memory before patching.
7. Finalize only after passing verification.
8. Record user correction when rejecting a strategy.

## Success criteria for first dogfood

- Agent calls `bootstrap_project`.
- Agent records terminal errors without creating fake verified memories.
- Agent searches before patching.
- Agent respects `rejected_fix` / `project_preference` warnings.
- Agent writes verified memory only after test/typecheck/build passes.
- Dashboard shows memory and recurring error state.
