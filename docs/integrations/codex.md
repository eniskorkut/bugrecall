# Codex Integration

Codex MCP configuration can vary by version/environment. Use the generic stdio command below.

## Config template

```json
{
  "mcpServers": {
    "bugrecall": {
      "command": "node",
      "args": ["/absolute/path/to/bugrecall/bin/pma.js"]
    }
  }
}
```

## Recommended compact toolset for Codex

Use compact MCP tool exposure for Codex:

```json
{
  "mcpServers": {
    "bugrecall": {
      "command": "node",
      "args": ["/absolute/path/to/bugrecall/bin/pma.js"],
      "env": {
        "BUGRECALL_TOOLSET": "codex"
      }
    }
  }
}
```

If your Codex MCP config does not support `env`, use wrapper command:

`env BUGRECALL_TOOLSET=codex node /absolute/path/to/bugrecall/bin/pma.js`

## Recommended first instruction to Codex

Use Bugrecall for this repository.  
First call `bootstrap_project` and `get_project_profile`.  
When a terminal/typecheck/test/build error occurs, ingest it with Bugrecall.  
Before patching, call `search_project_experience`.  
If a result looks relevant, fetch details with `get_memory_detail`.  
Respect `rejected_fix` and `project_preference` warnings.  
Only call `finalize_successful_fix` after the relevant command passes.  
If I reject a fix strategy, record it with `record_user_correction`.

## Monorepo instruction

Use `workspace_path` (example: `apps/web`) when working inside a specific workspace.

## Quick smoke test

1. Ask Codex to list Bugrecall tools.
2. Ask it to call `health_check`.
3. Ask it to call `bootstrap_project`.
4. Open dashboard: `http://127.0.0.1:1453`.
