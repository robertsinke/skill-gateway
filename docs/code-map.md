# Repository map

Routing index only: implementation files remain authoritative. Runtime paths and deployment entrypoints are intentionally unchanged.

## Main paths

- **Skill discovery:** [`src/search.ts:100`](../src/search.ts#L100) loads catalogs and serves search/exact lookup; [`src/rank.ts:108`](../src/rank.ts#L108) owns ranking. [`src/metadata.ts:20`](../src/metadata.ts#L20) enriches descriptions; [`src/sources.ts:8`](../src/sources.ts#L8) resolves provenance.
- **BB-owned selection:** [`src/select.ts`](../src/select.ts) is the provider-neutral entry (`selectSkill`, `selectFromStdin`) over [`src/jev-skill-suggestion.ts`](../src/jev-skill-suggestion.ts); [`bb-plugin/server.ts`](../bb-plugin/server.ts) exposes it to BB over an authenticated route and owns the per-session loaded set; [`extensions/jev-skill-suggestion-bb.ts`](../extensions/jev-skill-suggestion-bb.ts) is the Pi adapter that suppresses the roster and injects the answer.
- **Prompt injection:** [`src/prompt-hook.ts:63`](../src/prompt-hook.ts#L63) coordinates shortlist search, gate decision, formatting, and query logging. [`src/skill-gate.ts:24`](../src/skill-gate.ts#L24) owns the Jev request/decision; [`src/pi-gate-telemetry.ts`](../src/pi-gate-telemetry.ts) formats Pi diagnostics; [`src/secrets.ts:96`](../src/secrets.ts#L96) owns the TypeSafe key; [`src/query-log.ts:41`](../src/query-log.ts#L41) records prompt/follow-up events.
- **Usage evidence:** [`src/usage-events.ts:12`](../src/usage-events.ts#L12) appends gate/load telemetry; [`src/skill-load-hook.ts:12`](../src/skill-load-hook.ts#L12) verifies non-Pi skill reads, while the Pi adapter tracks reads against each active user-message turn; [`src/usage-turn-dataset.ts`](../src/usage-turn-dataset.ts) owns exact turn joins; `scripts/build-usage-turn-dataset.ts` is its CLI wrapper. [`src/skill-usage-feedback.ts`](../src/skill-usage-feedback.ts) searches linked turns and appends private feedback snapshots; the CLI entrypoint is `src/skill-usage-feedback-cli.ts`.
- **MCP and dashboard:** [`src/mcp.ts:184`](../src/mcp.ts#L184) owns skill-library and usage-feedback MCP tools; [`src/http-mcp.ts:16`](../src/http-mcp.ts#L16) exposes them over loopback HTTP; [`src/serve.ts:160`](../src/serve.ts#L160) serves the local dashboard and API. UI source lives in `src/ui/`.
- **Host adapters:** [`src/picker-contract.ts:4`](../src/picker-contract.ts#L4) is shared by `extensions/skill-gateway.ts` and its Pi extension tests. The Pi extension owns the footer status and `/skill-gate` detail view. The Codex pointer implementation is [`src/codex-pointers.ts:27`](../src/codex-pointers.ts#L27), invoked by `scripts/sync-codex-skill-pointers.ts`.
- **Library maintenance/evaluation:** [`src/scan.ts:27`](../src/scan.ts#L27) scans skill sources; [`src/check.ts:13`](../src/check.ts#L13) checks declared targets; [`src/holdout.ts:40`](../src/holdout.ts#L40) scores the holdout fixture.

## Directory roles

| Path | Owns |
| --- | --- |
| `src/` | TypeScript runtime, reusable logic, and service entrypoints. `src/ui/` is the Svelte dashboard. |
| `test/` | Node tests, generally paired with the source module they exercise. |
| `extensions/` | Pi host extension. `jev-skill-suggestion-bb.ts` is the BB-backed adapter. |
| `bb-plugin/` | BB plugin that owns per-message selection, the loaded-skill state, and the dashboard panel. |
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
- **BB-owned selection:** change `src/select.ts` and `bb-plugin/server.ts` together; check `test/select.test.ts` and `test/bb-skill-adapter.test.ts`, then rebuild `dist/select.js` and `bb plugin build bb-plugin`.
- **Dashboard in BB:** `npm run build:ui:bb` writes `dist/ui-bb` with the plugin's base path; `bb-plugin/app.tsx` registers the panel and `bb-plugin/server.ts` serves those files plus the `/api` relay. `src/ui/api.ts` is the only place the dashboard chooses direct versus relayed requests.
- **HTTP/MCP/UI behavior:** trace `src/http-mcp.ts`, `src/mcp.ts`, `src/serve.ts`, and `src/ui/`; check the corresponding MCP, HTTP, serve, and picker-HTTP tests.
- **Build/deployment:** `package.json`, `tsconfig.json`, and `vite.config.ts` define output layout. `dist/search.js` is invoked by the prompt hook and gateway skill; `dist/http-mcp.js` is invoked by the package script and plugin launcher; `dist/skill-usage-feedback-cli.js` is the global CLI fallback. Preserve these entrypoints unless updating every consumer.

The flat source/test layout is deliberate for now: module paths are small and correspond to stable build/runtime paths. Group files only when a feature gains enough internal structure to make a new directory clearer than the current ownership boundaries.

## Panel theming

`bb-plugin/components/themed-dashboard.tsx` reads the host's theme tokens from
`document.documentElement` and posts them into the dashboard frame, re-reading
on theme, style, and `prefers-color-scheme` changes. `bb-plugin/server.ts`
injects the receiving script into `index.html` and maps tokens onto the
dashboard's own variables (`--paper`/`--sidebar` ← `--canvas`, `--ink` ← `--ink`,
`--line` ← `--border`, `--active` ← `--accent`). `src/ui/app.css` derives every
neutral from `--ink` and `--paper` so one mapping covers light and dark; its
`:root` hexes are the standalone defaults used outside BB.

The panel's navigation belongs to BB: the plugin registers one fixed tab per
dashboard view (`Skills`, `Router`, `Analytics`, `Settings`) with
`context: { kind: "nav-panel" }`, and each frame loads
`?embedded=1&view=<view>`. `App.svelte` drops its own sidebar when `embedded`
is set, so the host header is the only chrome. The rail icon is `Target`
(the gateway picks one skill); it is not used by another plugin.

## Decision ledger

`src/select.ts` appends one `gate_decision` row per selection with the asking
host (`platform`), session, injected names, candidates, probability, reason,
and latency; `record: false` disables it for tests and embedding hosts.
`src/selection-log.ts` reads that ledger back for the dashboard's Selection
view, newest first, with status counts; `serve.ts` exposes it at
`/api/selection`. The dashboard's Analytics view keeps the older prompt-hook
search log, which still fills when a host does not use the gateway.

### `requests`: one entry per model call

Both writer paths record what they actually asked the model, in the same shape,
so one query spans hosts:

```json
"requests": [
  { "phase": "gate",   "status": "ok",    "reason": null,      "latency_ms": 393 },
  { "phase": "rerank", "status": "error", "reason": "timeout", "latency_ms": 2000 }
]
```

- `phase` — `gate` or `rerank` (`MODEL_PHASES` in `src/selection-log.ts`). The
  Jev path wrote `ranking` for its first call before the vocabulary was shared;
  the reader still reads those rows as `gate`.
- `status` — `ok` or `error`, describing that call, not the decision.
- `reason` — why the call failed (`timeout`, `http_429`,
  `invalid_answers`, …), `null` when it succeeded.
- `latency_ms` — that call's own wall time. The row's top-level `latency_ms`
  stays what it always meant: the gate call for the hook, the whole selection
  for `select.ts`.

An empty array means no call was attempted — a bypassed gate or no candidates —
which is not a failure. `src/prompt-hook.ts` writes one entry per call it made
(gate always when attempted, rerank when shadow or experiment mode ran it);
`src/select.ts` writes the Jev ranking and rerank calls. The reader turns the
first failed entry into `failure` (`gate timeout`), which the Selection view
shows beside the decision's reason. Tests in `test/prompt-hook.test.ts` and
`test/select.test.ts` assert both writers stay inside `MODEL_PHASES`.

The plugin's `gateway-server` background service owns the dashboard's data
server: it probes `gatewayServerUrl`, adopts a server that already answers,
otherwise spawns `serverEntry`, waits for `/api/settings`, and terminates the
child it started when the service is aborted (reload, disable, shutdown).
`manageServer: false` leaves the server entirely to the user.

`bb-plugin/server-supervision.ts` answers whether a LaunchAgent already runs that
entrypoint; when one does, the plugin treats the server as managed elsewhere and
never starts a second copy. Only a plist whose program arguments name the
configured `serve.js` counts, so the gateway's MCP LaunchAgent does not disable
management.
