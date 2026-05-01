# Generic MCP Integration

Bugrecall exposes an MCP stdio server.

- Command: `node`
- Args: `["/absolute/path/to/bugrecall/bin/pma.js"]`

## Minimal template

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

## Setup notes

1. Use an absolute path to `bin/pma.js`.
2. Build first:
   - `npm install`
   - `npm run build`
   - `npm run doctor`
3. `stdout` is reserved for MCP protocol.
4. Logs should go to `stderr`.

## Dashboard (separate process)

- Run: `node bin/pma.js dashboard`
- URL: `http://127.0.0.1:1453`
