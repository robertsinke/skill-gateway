# Skill Gateway

Local skill discovery for agents that need to search a private skill library without publishing that library.

## What it provides

- TypeScript search, ranking, exact-name lookup, and holdout scoring.
- A prompt hook that returns a short skill shortlist.
- MCP tools for searching and reading skills.
- A loopback HTTP MCP server and a small local dashboard.
- Optional Codex plugin packaging with an MCP Apps result widget.

The repository contains the gateway code and public test fixtures. Your personal skill library stays outside the repository. Runtime roots are selected from `SKILL_GATEWAY_ROOT`, the local skills-manager directory, and the standard agent skill directories. See [the code map](docs/code-map.md) for module ownership and change-impact paths.

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

## Prompt injection gate

The prompt hook searches the local library first, then sends the current user prompt and up to five candidate names/descriptions (not local paths or full history) to TypeSafe Jev `jev-1.13.0`. It injects the shortlist only when the Noul probability is at least `0.5`; no search hits or a gate error/timeout means no injection. The API key is read from the local secret store. Calls are billed and send prompt text to TypeSafe. The gate times out after 6.5 seconds to stay within the configured 10-second host-hook deadline. Set `SKILL_GATEWAY_GATE_MODE=off` to bypass the gate and restore unfiltered shortlist injection as a rollback.

Gate decisions are appended to local, mode-`0600` `usage-events.jsonl`: candidate names and retrieval scores, pass/reject/error, probability, threshold, latency, request-size/token/cost metrics, session/turn IDs, and a prompt hash (not the prompt itself). A `PostToolUse` observer registered in `~/.hooks/manifest.json` records verified reads/invocations of library `SKILL.md` files as `skill_load` events for Claude Code, Codex, Pi, and OpenCode; it stores only the skill name and correlation IDs, not file paths, tool arguments, or output. Other runtimes need equivalent adapters before their loads are counted. Existing `queries.jsonl` retains the prompt and follow-up/reaction fields and is mode-`0600`; the learning dataset excludes follow-ups and reactions.

In Pi, the footer status shows the gate decision, Jev's single `any_skill` probability, injected count, input-token usage, calculated cost, and top local retrieval ranks (these are not per-skill Jev scores). A clickable `Skill search` feedback row below the editor offers helpful/not-useful ratings and a one-line private note prompt; `/skill-feedback` provides the keyboard path (mouse clicks are handled in fullscreen TUI). `/skill-gate` opens a scrollable view of the current request reconstruction and token metrics. Prompt text is held in extension memory for that view and is not added to `usage-events.jsonl`; candidate descriptions are reconstructed from the current local library, and the request body is hidden if its candidate list no longer matches the recorded shortlist. Jev-reported token usage is used when returned; otherwise the view labels a rough byte-based estimate. Cost uses TypeSafe's published Jev 1.13 rate of $0.042 per million input tokens; output tokens are free. The cost is calculated from reported or estimated input tokens, not copied from a provider invoice. Source: [TypeSafe models and pricing](https://docs.typesafe.ai/models.md).

`npm run build:usage-dataset` joins gate decisions, verified loads, queries, and explicit feedback only by exact user/session/turn IDs. It writes `~/.local/share/skill-gateway/usage-turn-dataset-v2.jsonl` and metadata with mode `0600`; the dataset includes prompt text and current explicit feedback labels/comments for local analysis, while passive reactions and follow-ups remain excluded. The prior v1 artifact is left untouched. The Pi hooks-use bridge supplies per-run turn IDs to prompt and tool hooks. Older records missing turn IDs are counted as unlinked, not guessed into turns.

The local MCP tools `usage_feedback_search_turns` and `usage_feedback_update_turn` support turn-level corrections and shortlist ratings. Search reads local event/query/feedback JSONLs and reuses the exact user/session/turn join, but returns IDs and gate/load/label metadata—not stored prompt or comment text. Update appends a feedback snapshot to `~/.local/share/skill-gateway/skill-usage-feedback.jsonl` with mode `0600`, preserving the raw logs. A shortlist rating is a distinct learning label; it does not imply that any individual skill was unwanted. Exact injected skills marked unwanted, exact verified loads marked unwanted, ratings, and optional verbatim comments or labeled paraphrases appear in the private v2 dataset; later snapshots replace the current label state without deleting history. The globally deployed `skill-usage-feedback` skill uses these tools when connected. Pi and the Codex plugin register the same server as `skill_gateway`.

For hosts without the Skill Gateway MCP connection, the same search/update logic is available through the local CLI at `~/.local/share/skill-gateway/dist/skill-usage-feedback-cli.js`; pass a JSON object on stdin (`search -` or `update -`). The CLI returns sanitized JSON, and update writes only the private feedback snapshot. Rebuild and deploy after source changes; restart the MCP host to expose updated MCP tool definitions.

### Pi cache-prefix experiment

A controlled Pi run used `openai-codex/gpt-6-luna`, identical synthetic prompts and a fixed cache key. The treatment added a 1,307-character synthetic `before_agent_start` custom message, matching the observed injection size without sending user history or skill descriptions. Cache-read share is `cacheRead / (cacheRead + input)` from Pi's usage record. On repeated requests:

| Case | Cached-read tokens | Uncached input tokens | Cache-read share |
|---|---:|---:|---:|
| No injected context | 8,960 | 198 | 97.8% |
| Injected context | 8,960 | 417 | 95.5% |

The injection added 219 uncached tokens; the cached prefix stayed at 8,960. In this test, it lowered the cache-read share by 2.3 percentage points by enlarging the uncached suffix, not by flushing the prefix. This confirms Pi's `before_agent_start` custom-message path preserves the prefix for this model and setup; it is not a measurement of real-session hit rates.

## Keeping the library private

The local library and query log are ignored by Git. Before making a repository public, scan the working tree and history for credentials, personal paths, and private skill content. Never commit `.env` files, tokens, or copied skill-library directories.

## License

Add a license before distributing this repository.
