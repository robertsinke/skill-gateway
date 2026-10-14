# Native skill picker proof of concept

The gateway keeps skill bodies private and exposes only names/descriptions for suggestions. A selected skill is read through the existing local HTTP MCP service. The service must already be running; this PoC does not start or supervise it.

## Pi

Load the extension with the Pi version that exposes `getArgumentCompletions`:

```sh
pi -e ./extensions/skill-gateway.ts
```

The extension registers the bare backslash key (`\`) as a shortcut to search private-library skills without colliding with Pi's built-in `/skill:<name>` commands for locally loaded skills. Enter a skill name or search query; an exact name selects that skill immediately, while partial names and free-text queries show ranked metadata for selection. Pi sends a short instruction to read the selected skill through `skills_read_skill`; the body is not inserted into the composer. If the service cannot be reached, Pi shows an error.

The extension uses `SKILL_GATEWAY_MCP_URL` when set, otherwise `http://127.0.0.1:8742/mcp`.

## Codex CLI

Codex CLI 0.162.1 has no plugin-defined dynamic autocomplete API. Its supported picker discovers local skills, so this PoC syncs small pointer skills containing only each skill's name, description, and an MCP read instruction. It does **not** copy library bodies or paths. Codex's native picker supplies filtering/ranking; it does not use gateway BM25.

With the gateway library available, sync pointers into a Codex skill root (user-level by default in this example):

```sh
npm run sync:codex-pointers -- --output "$HOME/.agents/skills"
```

Use the plugin's existing install flow so its `skill_gateway` MCP server is configured, then start a new Codex CLI session. Type `/skills` or `$` to choose a pointer skill; the native picker narrows as you type. Selecting one invokes the pointer, which tells Codex to call `skills_read_skill` for the exact library name. Skill bodies are returned only after selection. Re-run the sync command after library metadata changes; Codex detects skill changes automatically, but restart the session if a change does not appear.

The sync command refuses to overwrite unowned or user-modified pointer files and removes stale generated pointers only when their marker and content hash still match. Choose a Codex skill root intentionally; `--output` is required.

## Limits

- Pi prioritizes exact skill names, then uses the gateway BM25 ranker; Codex uses its native skill picker over synced metadata.
- Codex pointers require an explicit sync when library names/descriptions change.
- Both adapters assume the gateway MCP service is already running and report unavailable-service errors; neither restarts it.
- Only metadata is present in suggestions and pointer files. Full skill bodies are fetched over MCP after selection.
