# Cursor Integration

Cursor MCP setup UI/config may vary by version.  
Use this generic MCP stdio template and adapt it to your environment.

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

## Recommended prompt for Cursor agent

Use Bugrecall for this repository.  
Bootstrap first, ingest errors, search project experience before patching, respect warnings (`rejected_fix`, `project_preference`), and finalize only after verification passes.

## Monorepo note

Pass `workspace_path` consistently (examples: `apps/web`, `packages/api`) so retrieval and memory writes stay workspace-scoped.
