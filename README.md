# Skill Gateway

Local skill discovery for agents that need to search a private skill library without publishing that library.

## What it provides

- TypeScript search, ranking, exact-name lookup, and holdout scoring.
- A prompt hook that returns a short skill shortlist.
- MCP tools for searching and reading skills.
- A loopback HTTP MCP server and a small local dashboard.
- Optional Codex plugin packaging with an MCP Apps result widget.

The repository contains the gateway code and public test fixtures. Your personal skill library stays outside the repository. Runtime roots are selected from `SKILL_GATEWAY_ROOT`, the local skills-manager directory, and the standard agent skill directories.

## Local setup

Requirements: Node.js 22 or newer.

```sh
npm install
npm run build
npm test
```

Start the local MCP endpoint:

```sh
SKILL_GATEWAY_ROOT="$PWD" npm run start:mcp:http
```

The endpoint binds to `127.0.0.1:8742`. It is intended for local use. Do not expose it directly to the internet; put authentication and a private tunnel in front of it first.

## Codex plugin

The local marketplace and plugin package live under `.agents/plugins/`. From the repository root:

```sh
codex plugin marketplace add "$PWD"
codex plugin add skill-gateway@skill-gateway-local
```

Set `SKILL_GATEWAY_ROOT` to this checkout before starting the MCP server or using the prompt hook.

## Keeping the library private

The local library and query log are ignored by Git. Before making a repository public, scan the working tree and history for credentials, personal paths, and private skill content. Never commit `.env` files, tokens, or copied skill-library directories.

## License

Add a license before distributing this repository.
