# Dogfood Guide

This guide helps you use Bugrecall in another local project.

## Prerequisites

- Bugrecall clone path (absolute).
- Target project path.
- `npm install` and `npm run build` completed in Bugrecall.

## Setup

1. Build Bugrecall:
   - `cd /absolute/path/to/bugrecall/project-memory-agent`
   - `npm run build`
2. Add MCP config in your coding client:
   - command: `node`
   - args: `["/absolute/path/to/bugrecall/project-memory-agent/bin/pma.js"]`
3. Open target project in your coding tool.

## Recommended first dogfood scenario

1. Choose a project with tests/typecheck.
2. Start dashboard:
   - `node /absolute/path/to/bugrecall/project-memory-agent/bin/pma.js dashboard`
3. Ask agent:
   - "Use Bugrecall to bootstrap this project. Then run typecheck/test through Bugrecall. If errors occur, ingest them, search memory, and only finalize a fix after the command passes."
4. Intentionally record one correction:
   - "Record this in Bugrecall as a user correction: do not use any casts in this project for TypeScript errors."
5. Verify dashboard:
   - Memories
   - Recurring Errors
   - User Corrections
   - Task Runs
6. Run retrieval eval in Bugrecall repo:
   - `npm run eval:retrieval`

## Sample prompts

- "Use Bugrecall to bootstrap this project and show detected profile."
- "Use Bugrecall while debugging: ingest terminal errors, search memory before patching, finalize only after test/typecheck pass."
- "Use Bugrecall with workspace_path `apps/web` for this monorepo task."

## Dogfood notes to collect

- Did the agent call the right tools?
- Did retrieval return useful memories?
- Did agent avoid rejected fixes?
- Were recurring errors useful?
- Was dashboard understandable?
- Was any output too verbose?
