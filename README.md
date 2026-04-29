# project-memory-agent

TypeScript Node.js MCP server scaffold using the official `@modelcontextprotocol/sdk`.

## Features

- Stdio transport (`StdioServerTransport`)
- CLI entrypoint at `bin/pma.js`
- One tool: `health_check`
- No memory implementation yet
- Logs are written to `stderr` only (stdout reserved for MCP protocol)

## Local setup

```bash
npm install
```

## Scripts

```bash
npm run dev
npm run build
npm run typecheck
```

## Run locally

Build first, then run the CLI:

```bash
npm run build
node bin/pma.js
```

Or after install (uses `bin` mapping):

```bash
npm run build
npx pma
```

## MCP tool

- `health_check`
  - Input: `{}` (empty object)
  - Output: JSON text with `status` and `service`
