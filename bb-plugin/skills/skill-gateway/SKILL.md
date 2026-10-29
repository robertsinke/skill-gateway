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

## The dashboard's data server

The plugin runs `serve.js` itself as a background service: it adopts a server
already listening on `gatewayServerUrl`, starts one when the port is idle, and
stops it on unload. If a LaunchAgent already runs that `serve.js`, the plugin
leaves the server to launchd and never starts a second copy. `bb plugin config
skill-gateway set manageServer false` hands the job back to you
(`node ~/.local/share/skill-gateway/dist/serve.js`).

## Select for a prompt by hand

```bash
echo '{"prompt":"fix the flaky upload test","sessionId":"manual","threadId":"thr_…"}' > /tmp/req.json
bb skill-gateway select --json "$(cat /tmp/req.json)"
```

`threadId` is optional and only used for the ledger: the panel leads with the
decisions recorded for the thread it is showing, so an adapter that knows its
thread passes it through.

Returns `{name, context, reason, inline, latency_ms, candidates}`. `name` is
`null` when Jev rejects the prompt, no candidate matched, or selection failed;
`reason` says which. `context` is the text a host adapter injects.

## Limits

- One selection per user message. Skills already injected in the same session
  are re-referenced, not inlined again.
- Selection needs the TypeSafe key on the server machine. Without it the
  answer is `credential_unavailable` and no skill is injected.
- Prompt and candidate excerpts are sent to TypeSafe. Nothing is logged here.
- Every selection writes one `gate_decision` row to the ledger. The panel's
  Selection view leads with the thread BB is showing, then all hosts; that view
  is the only place an injection and its reason are visible on this side, since
  Pi's statusline and its custom messages never reach BB's timeline.
- HTTP route `/select` requires the plugin token: `bb plugin token skill-gateway`.

## Surfaces

- `experimental_appOverlay` `injection-chip`: a fixed chip above the composer stating the newest decision for the open thread (`Injected ce-work 12:41` / `No skill 12:38`). Pointer-inert; the full reason lives in its tooltip. It reads `GET /api/injection?thread=<id>` every 2.5 s and polls only while a thread route is open.
- `navPanel` `dashboard` + fixed tabs: the full Selection history, led by *This thread*.

Both resolve the thread through `useThreadId()` in `thread.ts`, which reads the route's `threadId` and otherwise falls back to the last thread the overlay saw — a plugin panel has its own route, so route context alone loses the thread as soon as the panel opens.
