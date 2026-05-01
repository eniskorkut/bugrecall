# Claude Integration (Claude Code / Claude Desktop)

Exact MCP config location may differ between Claude products and versions.  
Use this stdio template and adapt it to your client.

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

## Recommended agent instruction

Use Bugrecall for this repository.  
Bootstrap first, ingest errors when they happen, search memory before patching, fetch detail when relevant, and finalize only after verification passes.  
If I reject a strategy, record it as user correction.

## Workflow note

- Do not write every terminal error as verified memory.
- Verified memory should be created only after command/test success and confirmed fix.

## Troubleshooting basics

- Use absolute path to `bin/pma.js`.
- Run `npm run build` first.
- Check Node version and `npm run doctor`.
- Dashboard is not the MCP server process.
