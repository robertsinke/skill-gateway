---
name: skill-gateway
description: The skill library is selected per message by Skill Gateway. Use this when you need to search the library, read a skill that was not injected, or check why no skill was selected.
---

# Skill Gateway (BB plugin)

BB owns skill selection. For each user message a host adapter suppresses the
provider's own skill roster and asks this plugin for one skill or none: it
searches the local library, asks Jev, and injects only that skill.

You therefore see no skill catalog. That is intentional, not a fault.

## Inspect the plugin

```bash
bb skill-gateway status --json
```

Reports the select entrypoint and library root. Both paths must exist on the
BB server machine; selection reads skill files there.

## Select for a prompt by hand

```bash
echo '{"prompt":"fix the flaky upload test","sessionId":"manual"}' > /tmp/req.json
bb skill-gateway select --json "$(cat /tmp/req.json)"
```

Returns `{name, context, reason, inline, latency_ms, candidates}`. `name` is
`null` when Jev rejects the prompt, no candidate matched, or selection failed;
`reason` says which. `context` is the text a host adapter injects.

## Limits

- One selection per user message. Skills already injected in the same session
  are re-referenced, not inlined again.
- Selection needs the TypeSafe key on the server machine. Without it the
  answer is `credential_unavailable` and no skill is injected.
- Prompt and candidate excerpts are sent to TypeSafe. Nothing is logged here.
- HTTP route `/select` requires the plugin token: `bb plugin token skill-gateway`.
