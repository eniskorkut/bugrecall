# MCP Client Templates

Bugrecall runs as stdio MCP server:

- command: `node`
- args: `["/absolute/path/to/bugrecall/bin/pma.js"]`

## Generic MCP template

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

## Codex compact mode

Full mode is default. For Codex, prefer compact toolset:

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

If `env` is not supported by your Codex MCP config, use wrapper command:

`env BUGRECALL_TOOLSET=codex node /absolute/path/to/bugrecall/bin/pma.js`

## Integration guides

- [Generic MCP](integrations/generic-mcp.md)
- [Codex](integrations/codex.md)
- [Claude](integrations/claude.md)
- [Cursor](integrations/cursor.md)
- [Agent instructions](integrations/agent-instructions.md)
- [Troubleshooting](integrations/troubleshooting.md)

## Monorepo note

Monorepo workspace targeting is done per tool call with `workspace_path` (example: `apps/web`), not by changing server command.
