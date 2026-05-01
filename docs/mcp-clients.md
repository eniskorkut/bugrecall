# MCP Client Templates

Bugrecall runs as stdio MCP server:

- command: `node`
- args: `["/absolute/path/to/bugrecall/project-memory-agent/bin/pma.js"]`

## Generic template

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

## Codex

Codex MCP configuration varies by version. Use the same stdio command and adapt it to your current Codex MCP config surface.

## Claude Desktop / Claude Code

Use the generic stdio template and adapt it to your client MCP config file or UI.

## Cursor

Use the generic stdio template and adapt to current Cursor MCP config method.

## Monorepo note

Monorepo workspace targeting is done per tool call with `workspace_path` (example: `apps/web`), not by changing server command.

## cwd behavior

Bugrecall resolves project/workspace identity using:

- process `cwd` from MCP host
- optional `workspace_path` passed to tools

If your MCP host runs from repo root but task is in sub-workspace, pass `workspace_path`.
