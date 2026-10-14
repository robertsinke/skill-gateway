# Native skill slash picker proof of concept for Pi and Codex

Build a proof of concept for native slash-command skill pickers in Pi and Codex, backed by the gateway's private library and existing custom BM25 relevance search. Selecting an item inserts a reference that tells the agent to read that skill. For the PoC, assume the gateway service is already running; automatic recovery is deferred.

## Context

The gateway centralizes private skills in a library, but harnesses no longer have directly readable copies to expose through their ordinary skill slash commands. The gateway already parses the skill catalog and ranks results using its custom BM25 implementation. The repo has a local HTTP MCP server and Codex plugin packaging; it does not yet have a composer autocomplete interface or Pi adapter.

## Requirements

- Pi and Codex are the proof-of-concept harnesses.
- In the composer, a standalone slash-command trigger opens the harness's native skill picker; typing more text narrows the list.
- Suggestions use the existing gateway relevance ranking (custom BM25), not a separate adapter-specific ranking implementation.
- Selecting a skill inserts a reference/invocation that tells the agent to read the selected library skill. It is not a confirmation step and should not paste the skill body into the composer.
- The proof of concept assumes the gateway HTTP MCP service is already running. If it is unavailable, show a clear error; automatic startup/recovery is not part of this PoC.
- Keep library contents private; expose only the metadata necessary for suggestions and a selected skill reference.

## Non-goals

- Supporting harnesses other than Pi and Codex.
- Replacing or proxying a harness's composer UI.
- Deploying library copies into each harness's native skill directory as the solution to picker availability.
- Changing BM25 behavior or tuning ranking against the current live library.
- Automatic gateway startup/recovery, process supervision, production installation/update lifecycle, or adapter self-repair.

## Current system

- `src/search.ts` loads skill catalogs and exposes `search` / `searchRoots`, returning ranked results with metadata and paths.
- `src/rank.ts` implements the custom BM25 ranker. Name and description fields have explicit relative weights; adapters should call this implementation rather than reimplement it.
- `src/mcp.ts` provides the existing MCP skill-library tools; `src/http-mcp.ts` and `src/serve.ts` expose the service over HTTP. Plugin MCP configuration points to `http://127.0.0.1:8742/mcp`.
- `.agents/plugins/skill-gateway/` contains current Codex plugin packaging and hook configuration. Its MCP configuration assumes a localhost endpoint; `scripts/start-private.sh` launches the gateway process but does not supervise/restart a server.
- `src/prompt-hook.ts` is a prompt-injection integration, not an interactive composer completion interface.

## Proposed design

Keep three responsibilities distinct:

1. **Gateway core:** expose ranked skill suggestions and exact selected-skill resolution through the smallest suitable local interface. Reuse catalog and BM25 code. Keep suggestion payloads minimal (name, description, stable skill identifier); never return full skill bodies for autocomplete.
2. **Harness adapters:** each adapter implements the host's native composer trigger, filtering, dropdown navigation/selection, and slash-command reference semantics. Share search and selection semantics, not UI code. Confirm host APIs before implementing; do not assume identical behavior.
3. **Service availability:** for this PoC, use the existing configured local HTTP MCP service and assume it is running. If unavailable, present a clear failure. Do not add auto-start, retries, process supervision, or server lifecycle changes.

Selection inserts the skill reference into the composer; it does not trigger a separate confirmation flow. Prefer the host's native skill invocation by name. Otherwise use a concise skill name/stable identifier with the gateway's documented read mechanism. Do not interpolate untrusted filesystem paths into commands or expose skill bodies during autocomplete. Confirm the exact syntax through end-to-end testing in both hosts.

## Implementation units

### 1. Verify host APIs and reference semantics

Inspect current Pi extension APIs and Codex plugin/command APIs: how native slash commands render suggestions, filter typed input, navigate/select, and invoke/read skills. Verify that each host can provide the desired inline picker through supported extension APIs and determine the syntax needed to insert a reference that makes the agent read a library-only skill. If a host lacks a supported inline picker, bring back the smallest native-compatible alternative before building a substitute UI. Gateway recovery is not a PoC gate.

### 2. Define and test the shared catalog/search contract

Add the smallest gateway interface needed for ranked suggestions and exact selection resolution, calling the existing catalog and BM25 implementation. Validate query and selected names at the boundary, handle empty query/no results, and avoid exposing skill content in suggestion responses. Add focused tests proving relevance ordering, exact resolution, malformed input handling, and library-missing behavior.

### 3. Implement the Pi adapter vertical slice

Package/register a Pi-native command/autocomplete integration. Implement slash trigger, incremental query suggestions, host-native list navigation, selection, and insertion of the resulting skill reference. Add adapter-level tests for filtering, selection, no matches, unavailable service, and failure messaging. Verify no skill body is unnecessarily injected into the composer/context.

### 4. Implement the Codex adapter

Extend the existing Codex plugin package using Codex's supported native command/extension mechanism. Reuse the shared search/resolve contract and preserve native host behavior. Add equivalent integration/contract coverage and test plugin packaging/registration.

### 5. Verify the end-to-end proof of concept

Run both adapters against a running gateway and a representative private library. Demonstrate the native picker, query narrowing, and insertion of the selected skill reference in each host. Verify a clear error when the configured server is unavailable. Document the minimal manual setup and remaining productization work; do not implement service recovery or installer lifecycle behavior.

## Validation

- **Unit:** query validation, BM25 ordering parity with `src/search.ts`, exact selected-skill resolution, empty library, and missing library.
- **Contract:** both adapters use the same suggestion/result contract and never load a skill body just to render suggestions.
- **Adapter integration:** in each supported host, `/` opens native suggestions, subsequent text narrows results, keyboard selection and cancellation work, and selection inserts the expected read-skill reference.
- **Unavailable service:** each adapter reports a clear error if the configured gateway endpoint cannot be reached; no automatic recovery is expected in the PoC.
- **Manual:** verify the end-to-end flow using the supported Pi and Codex versions available for the PoC, and document setup and limitations.

## Open Questions

- What exact reference syntax does each host accept to make the agent read a library-only skill without copying its contents into composer text? Close with a working end-to-end selection test in each host.
- Which Pi and Codex versions expose the necessary native picker APIs? Verify the PoC against available versions; set a supported-version policy only if/when productizing.
- Is the existing MCP search/read surface sufficient for interactive autocomplete latency and the required response shape, or is a small suggestion/resolve operation needed? Resolve while implementing the shared contract.

## Deferred beyond the proof of concept

- Automatic gateway startup/recovery, process ownership, health checks, concurrency handling, and cross-platform supervision.
- Production installation/update lifecycle and supported-version policy.
- Additional harness adapters.

## Sources & References

- `src/search.ts`
- `src/rank.ts`
- `src/mcp.ts`
- `src/http-mcp.ts`
- `src/serve.ts`
- `src/prompt-hook.ts`
- `.agents/plugins/skill-gateway/`
- `docs/plans/2026-09-25-001-refactor-typescript-skill-gateway-plan.md`
