# Repository map

Routing index only: implementation files remain authoritative. Runtime paths and deployment entrypoints are intentionally unchanged.

## Main paths

- **Skill discovery:** [`src/search.ts:100`](../src/search.ts#L100) loads catalogs and serves search/exact lookup; [`src/rank.ts:108`](../src/rank.ts#L108) owns ranking. [`src/metadata.ts:20`](../src/metadata.ts#L20) enriches descriptions; [`src/sources.ts:8`](../src/sources.ts#L8) resolves provenance.
- **Prompt injection:** [`src/prompt-hook.ts:63`](../src/prompt-hook.ts#L63) coordinates shortlist search, gate decision, formatting, and query logging. [`src/skill-gate.ts:24`](../src/skill-gate.ts#L24) owns the Jev request/decision; [`src/pi-gate-telemetry.ts`](../src/pi-gate-telemetry.ts) formats Pi diagnostics; [`src/secrets.ts:96`](../src/secrets.ts#L96) owns the TypeSafe key; [`src/query-log.ts:41`](../src/query-log.ts#L41) records prompt/follow-up events.
- **Usage evidence:** [`src/usage-events.ts:12`](../src/usage-events.ts#L12) appends gate/load telemetry; [`src/skill-load-hook.ts:12`](../src/skill-load-hook.ts#L12) verifies skill reads; [`src/usage-turn-dataset.ts`](../src/usage-turn-dataset.ts) owns exact turn joins; `scripts/build-usage-turn-dataset.ts` is its CLI wrapper. [`src/skill-usage-feedback.ts`](../src/skill-usage-feedback.ts) searches linked turns and appends private feedback snapshots; the CLI entrypoint is `src/skill-usage-feedback-cli.ts`.
- **MCP and dashboard:** [`src/mcp.ts:184`](../src/mcp.ts#L184) owns skill-library and usage-feedback MCP tools; [`src/http-mcp.ts:16`](../src/http-mcp.ts#L16) exposes them over loopback HTTP; [`src/serve.ts:160`](../src/serve.ts#L160) serves the local dashboard and API. UI source lives in `src/ui/`.
- **Host adapters:** [`src/picker-contract.ts:4`](../src/picker-contract.ts#L4) is shared by `extensions/skill-gateway.ts` and its Pi extension tests. The Pi extension owns the footer status and `/skill-gate` detail view. The Codex pointer implementation is [`src/codex-pointers.ts:27`](../src/codex-pointers.ts#L27), invoked by `scripts/sync-codex-skill-pointers.ts`.
- **Library maintenance/evaluation:** [`src/scan.ts:27`](../src/scan.ts#L27) scans skill sources; [`src/check.ts:13`](../src/check.ts#L13) checks declared targets; [`src/holdout.ts:40`](../src/holdout.ts#L40) scores the holdout fixture.

## Directory roles

| Path | Owns |
| --- | --- |
| `src/` | TypeScript runtime, reusable logic, and service entrypoints. `src/ui/` is the Svelte dashboard. |
| `test/` | Node tests, generally paired with the source module they exercise. |
| `extensions/` | Pi host extension. |
| `.agents/plugins/skill-gateway/` | Packaged plugin metadata, hooks, MCP configuration, and launcher. |
| `skills/gateway/` | Agent-facing gateway skill and its index. Other tracked `skills/` files are evaluation fixtures/catalog material, not the private skill library. |
| `scripts/` | Build-time page rendering, Codex pointer synchronization, and local usage-dataset CLI. |
| `docs/plans/` | Design/implementation plans; `docs/` also holds as-built notes and analyses. |
| `dist/` | Generated TypeScript/Vite output; edit its sources, not these files. |

## Change-impact shortcuts

- **Ranking or candidate lookup:** start with `src/rank.ts` and `src/search.ts`; check `test/rank.test.ts`, `test/search.test.ts`, plus consumers in `src/mcp.ts` and `src/prompt-hook.ts`.
- **Injection or gate behavior:** read `src/prompt-hook.ts`, `src/skill-gate.ts`, `src/pi-gate-telemetry.ts`, and the Pi extension; check the prompt-hook, gate, telemetry, and extension tests. Keep gate decisions separate from verified loads in `src/usage-events.ts` and `src/skill-load-hook.ts`; join them with `src/usage-turn-dataset.ts`.
- **Turn feedback labels:** use `src/skill-usage-feedback.ts` for exact-turn search, validation, and append-only snapshots; expose both MCP and CLI interfaces. Check the feedback module, CLI, and MCP tool tests.
- **Picker behavior:** change `src/picker-contract.ts` with `extensions/skill-gateway.ts`; check `test/picker-contract.test.ts` and `test/pi-extension.test.ts`.
- **HTTP/MCP/UI behavior:** trace `src/http-mcp.ts`, `src/mcp.ts`, `src/serve.ts`, and `src/ui/`; check the corresponding MCP, HTTP, serve, and picker-HTTP tests.
- **Build/deployment:** `package.json`, `tsconfig.json`, and `vite.config.ts` define output layout. `dist/search.js` is invoked by the prompt hook and gateway skill; `dist/http-mcp.js` is invoked by the package script and plugin launcher; `dist/skill-usage-feedback-cli.js` is the global CLI fallback. Preserve these entrypoints unless updating every consumer.

The flat source/test layout is deliberate for now: module paths are small and correspond to stable build/runtime paths. Group files only when a feature gains enough internal structure to make a new directory clearer than the current ownership boundaries.
