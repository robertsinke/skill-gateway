# Native skill picker proof of concept

The gateway keeps skill bodies private and exposes only names/descriptions for suggestions. A selected skill is read through the existing local HTTP MCP service. The service must already be running; this PoC does not start or supervise it.

## Pi

Load the extension with the Pi version that exposes `getArgumentCompletions`:

```sh
pi -e ./extensions/skill-gateway.ts
```

Type `\` in the composer to open ranked suggestions and filter as you type. Select a skill; Pi inserts a trailing space so you can add a request, for example `\archify show the new architecture`. On submit, the extension resolves the exact skill name and rewrites the token to Pi's native `/skill:name` command. The extension also registers the library roots through Pi's `resources_discover` API, so Pi's resource loader recognizes the skill and performs its standard skill-command expansion and rendering. Any remaining prompt text is passed as the native skill command's request argument. Suggestions expose only names and descriptions; Pi reads the selected `SKILL.md` through its native skill path. Skill names must follow Pi's native lowercase alphanumeric/hyphen naming rules. The panel reserves a fixed number of rows so the composer does not jump as match counts change. If the service cannot be reached, Pi shows an error.

The extension uses `SKILL_GATEWAY_MCP_URL` when set, otherwise `http://127.0.0.1:8742/mcp`.

## BB composer

Type `~` in the BB composer to search the Skill Gateway library, like `#` searches Inbox conversations. Suggestions contain only names and descriptions. Selecting a skill adds a mention pill; at send time the BB plugin reads only that skill and passes its instructions as hidden agent context. That explicit selection suppresses automatic Jev selection for the same message. This uses BB's supported mention-provider API (`@`, `#`, `$`, `!`, `~`); backslash is not a supported composer mention trigger. The Skill Gateway MCP service must be running.

## Codex CLI

Codex CLI 0.162.1 has no plugin-defined dynamic autocomplete API. Its supported picker discovers local skills, so this PoC syncs small pointer skills containing only each skill's name, description, and an MCP read instruction. It does **not** copy library bodies or paths. Codex's native picker supplies filtering/ranking; it does not use gateway BM25.

With the gateway library available, sync pointers into a Codex skill root (user-level by default in this example):

```sh
npm run sync:codex-pointers -- --output "$HOME/.agents/skills"
```

Use the plugin's existing install flow so its `skill_gateway` MCP server is configured, then start a new Codex CLI session. Type `/skills` or `$` to choose a pointer skill; the native picker narrows as you type. Selecting one invokes the pointer, which tells Codex to call `skills_read_skill` for the exact library name. Skill bodies are returned only after selection. Re-run the sync command after library metadata changes; Codex detects skill changes automatically, but restart the session if a change does not appear.

The sync command refuses to overwrite unowned or user-modified pointer files and removes stale generated pointers only when their marker and content hash still match. Choose a Codex skill root intentionally; `--output` is required.

## Limits

- Pi prioritizes exact skill names, then uses gateway BM25 ranking with short-prefix fallback; Codex uses its native skill picker over synced metadata.
- Pi only loads skill names valid under its native skill naming rules. Other library names cannot be invoked through Pi's `/skill:name` command.
- Codex pointers require an explicit sync when library names/descriptions change.
- Both adapters assume the gateway MCP service is already running and report unavailable-service errors; neither restarts it.
- Suggestions and pointer files contain metadata only. Pi loads the selected skill through its native resource loader; Codex fetches the selected body through MCP.
