# Skill Gateway private plugin

1. Build the gateway from the repository root:

   ```sh
   npm run build
   ```

2. Start the private loopback MCP endpoint:

   ```sh
   export SKILL_GATEWAY_ROOT=/path/to/skill-gateway
   .agents/plugins/skill-gateway/scripts/start-private.sh
   ```

3. Add the repository marketplace to Codex:

   ```sh
   codex plugin marketplace add /path/to/skill-gateway
   ```

4. Install **Skill Gateway (Local)** from the Plugins Directory and start a new chat.

The endpoint listens only on `127.0.0.1:8742`. Replace the URL in `mcp.json` and `.mcp.json` with a private MCP tunnel when connecting ChatGPT on the web. Later, replace it with the authenticated hosted HTTPS endpoint.

The `skills_search_library` tool returns structured results and an MCP Apps widget. ChatGPT shows a green connection indicator, the query, the result count, each returned skill, its score, and its local path. Codex and other MCP clients ignore the widget and keep the text result.
