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

## Offline runtime experiments

`npm run eval:skill-runtime -- --output <fresh-private-directory>` creates a local audit and frozen baseline. `npm run eval:skill-runtime:batch` prepares paired wording batches, registers prospective windows, and previews scoring locally. External scoring requires a separate exact-batch approval plus `--execute`. `--batch <directory> --report --output <fresh-private-directory>` produces a local paired report with regression checks and session-cluster uncertainty; prospective reporting finalizes that batch. No offline report activates a change. See [the experiment workflow](docs/skill-runtime-experiments.md) for commands, privacy boundaries, and safe resume behavior. `npm run eval:skill-rerank` evaluates explicit per-skill labels, joins recorded live selections, and checks cutoff calibration with entire sessions held out; see [the reranker evaluation and trial](docs/skill-rerank-experiment.md).

## Prompt injection gate

The prompt hook searches the local library first, then sends the current user prompt and up to five candidate names/descriptions (not local paths or full history) to TypeSafe Jev `jev-1.13.0`. It injects the shortlist only when the Noul probability is at least `0.5`; no search hits or a gate error/timeout means no injection. The API key is read from the local secret store. Calls are billed and send prompt text to TypeSafe. The gate times out after 6.5 seconds to stay within the configured 10-second host-hook deadline. Set `SKILL_GATEWAY_GATE_MODE=off` to bypass the gate and restore unfiltered shortlist injection as a rollback.

A per-skill reranking experiment is enabled for Pi in the local hooks manifest at the user's request. It uses a stable 50/50 session split: control retains the gated shortlist; the approved conservative treatment uses `relevance-v2` at `0.1`. This remains exploratory, not independently validated evidence of improved selection. See [the rerank experiment notes](docs/skill-rerank-experiment.md) for decision framing, limitations, logged signals, and privacy.

Gate decisions are appended to local, mode-`0600` `usage-events.jsonl`: candidate names and retrieval scores, pass/reject/error, probability, threshold, latency, request-size/token/cost metrics, session/turn IDs, and a prompt hash (not the prompt itself). A `PostToolUse` observer registered in `~/.hooks/manifest.json` records verified reads/invocations of library `SKILL.md` files as `skill_load` events for Claude Code, Codex, Pi, and OpenCode; it stores only the skill name and correlation IDs, not file paths, tool arguments, or output. Other runtimes need equivalent adapters before their loads are counted. Existing `queries.jsonl` retains the prompt and follow-up/reaction fields and is mode-`0600`; the learning dataset excludes follow-ups and reactions.

In Pi, the footer status shows the gate decision, Jev's single `any_skill` probability, injected count, input-token usage, calculated cost, and top local retrieval ranks (these are not per-skill Jev scores). At agent start, the `Rate injected skills` row appears above the editor; it refreshes after skill reads and at turn end. The form first asks whether any skills should have been injected at all, then lets you label each exact injected skill as relevant, not relevant, or unsure; skipping leaves it unknown. The overall question also appears when no skills were injected. `/skill-feedback` provides the keyboard path (mouse clicks are handled in fullscreen TUI). The row also shows which injected skills the agent explicitly read; verified reads are an automatic behavior proxy for relevance, not ground truth or a replacement for your labels. `/skill-gate` opens a scrollable view of the current request reconstruction and token metrics. Prompt text is held in extension memory for that view and is not added to `usage-events.jsonl`; candidate descriptions are reconstructed from the current local library, and the request body is hidden if its candidate list no longer matches the recorded shortlist. Jev-reported token usage is used when returned; otherwise the view labels a rough byte-based estimate. Cost uses TypeSafe's published Jev 1.13 rate of $0.042 per million input tokens; output tokens are free. The cost is calculated from reported or estimated input tokens, not copied from a provider invoice. Source: [TypeSafe models and pricing](https://docs.typesafe.ai/models.md).

`npm run build:usage-dataset` joins gate decisions, verified loads, queries, and explicit feedback only by exact user/session/turn IDs. It writes `~/.local/share/skill-gateway/usage-turn-dataset-v5.jsonl` and metadata with mode `0600`. Each row keeps the agent's verified reads separate from the user's overall injection decision and per-injected-skill relevance labels; reads are a behavior proxy, while labels are human judgments. Legacy coarse and interim skill-need labels are retained as legacy fields, not reinterpreted. Passive reactions and follow-ups remain excluded; prior v1/v2/v3/v4 artifacts are left untouched. The Pi hooks-use bridge supplies per-run turn IDs to prompt and tool hooks. Older records missing turn IDs are counted as unlinked, not guessed into turns.

The local MCP tools `search_turns` and `update_turns` support exact-turn search, an overall injection decision, and per-skill relevance labels. Search reads local event/query/feedback JSONLs and reuses the exact user/session/turn join, returning IDs and gate/load/label metadata—not stored prompt or comment text. Update appends a feedback snapshot to `~/.local/share/skill-gateway/skill-usage-feedback.jsonl` with mode `0600`, preserving raw logs. User relevance labels must match exact injected skill names; verified agent reads and explicit user relevance remain distinct. Exact injected skills marked unwanted and exact verified loads marked unwanted remain separate labels. Legacy coarse ratings and prior skill-need feedback are retained under legacy fields, not recoded. The private v5 dataset joins the overall injection decision, per-skill labels, and optional comments; later snapshots replace the current label state without deleting history. The globally deployed `skill-usage-feedback` skill directly uses `search_turns` and `update_turns` from the existing `skill_gateway` MCP server; no additional skill-loading step is required. Pi and the Codex plugin register the same server as `skill_gateway`.

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
