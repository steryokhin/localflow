# Local Flow — development rules

For working with tickets through `lf`, read `skills/localflow/SKILL.md` instead.
Local-only Jira mirror plus personal notes. Runs on a corporate machine: nothing may leave it.

## Hard rules

- Zero runtime dependencies. No `npm install`; only Node/Bun built-ins.
- TypeScript with erasable syntax only (no enums, namespaces, parameter properties). No build step.
  Imports use `.ts` extensions; type-only imports use `import type`.
- Network access lives only in `src/jira/client.ts`: GET only, configured Jira host only.
  The only listening socket is `src/serve/server.ts`, bound to `127.0.0.1`, Host-checked,
  mutations gated by the `X-LocalFlow` header. `test/network-guard.test.ts` enforces both — do
  not weaken it. The UI page loads nothing from outside (no CDN, no fonts, CSP `default-src 'self'`).
- Sync is one-way (Jira -> local). Never add code that writes to Jira.
- With `jira.transport: "import"` lf must open no outbound connection at all (`JiraClient` refuses
  non-loopback hosts). Anything that listens (web UI, a future MCP over HTTP) binds 127.0.0.1 only.
- Sync owns only `ticket.md`, `attachments/`, `raw/` inside a ticket folder. It must never modify
  user files (`notes.md` and anything else) after creating the initial `notes.md` stub.
- `ticket.md` rendering must be deterministic: it is tracked in git and every changed byte reads
  as "something new". Keep volatile fields out of it.
- The vault is a separate folder (default `~/LocalFlow`), a local git repo with no remote.
  Never put real Jira data, tokens or company-specific config into this code repository.
- Do not copy code from Tolaria (AGPL). Ideas only.

## Working here

- Tests: `node --test test/*.test.ts` (also passes under `bun test`). Test data is invented.
- Run the CLI: `bin/lf help`.
- Ticket prefix for branches: `lflow-NNN-…`.
- Code and comments in English; README and user communication in Russian.

## Roadmap

1. Sync + CLI (done in `lflow-001-mvp-sync`).
2. Local web UI: `lf serve` (done in `lflow-005-web-ui`; design in `docs/design-web-ui.md`).
3. MCP stdio server: `lf mcp`, hand-written JSON-RPC, Jira mirror read-only for agents.
