import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultRoots, loadMerged } from "../src/search.ts";
import { JevSkillSuggestion, JEV_UPSTREAM_POLICY, JEV_UPSTREAM_DEFAULTS, type FileSkill, type JevSuggestion } from "../src/jev-skill-suggestion.ts";
import { readTypeSafeKey } from "../src/secrets.ts";
import { appendUsageEvent, promptDigest } from "../src/usage-events.ts";
import { noteFollowup, record, userId, type GateAudit } from "../src/query-log.ts";
import { SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS } from "../src/skill-gate.ts";
import { DEFAULT_MODEL } from "../src/vendor/jev-skill-suggestion/policy.ts";

type Options = { apiKey?: string | null; fetcher?: typeof fetch; enabledByDefault?: boolean };

/** Explicit opt-in: pi -e ./extensions/jev-skill-suggestion.ts --jev-skill-suggestion */
export default function jevSkillSuggestion(pi: ExtensionAPI, options: Options = {}) {
  pi.registerFlag("jev-skill-suggestion", { type: "boolean", default: options.enabledByDefault ?? false,
    description: "Trial: original Jev chooser; sends prompt, roster and top-three skill excerpts to TypeSafe" });
  let chooser: JevSkillSuggestion | undefined;
  let generation = 0;
  const previousSession = process.env.SKILL_GATEWAY_PI_JEV_SESSION;
  const restore = () => {
    if (previousSession === undefined) delete process.env.SKILL_GATEWAY_PI_JEV_SESSION;
    else process.env.SKILL_GATEWAY_PI_JEV_SESSION = previousSession;
  };
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    generation++; chooser?.reset(); chooser = undefined;
    delete process.env.SKILL_GATEWAY_PI_JEV_SESSION;
    if (pi.getFlag("jev-skill-suggestion") !== true) return;
    let apiKey: string | null;
    try { apiKey = options.apiKey === undefined ? readTypeSafeKey() : options.apiKey; } catch { apiKey = null; }
    if (!apiKey) {
      ctx.ui.notify("Jev trial not enabled: needs a TypeSafe key. Current chooser unchanged.", "warning"); return;
    }
    chooser = new JevSkillSuggestion({ allowSkillExcerpts: true, apiKey, fetcher: options.fetcher });
    // Only this Pi session bypasses the old subprocess chooser. Child agents and other sessions retain it.
    process.env.SKILL_GATEWAY_PI_JEV_SESSION = ctx.sessionManager.getSessionId();
    ctx.ui.setStatus("jev-skill-suggestion", "Jev original: one skill or none");
  };
  // Pi emits session_start for new, resumed, switched and forked sessions.
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", () => { generation++; chooser?.reset(); restore(); });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!chooser) return;
    // Use Pi's supported structured skill section, not regex replacement of the system prompt.
    const native = event.systemPromptOptions.skills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath, disableModelInvocation: s.disableModelInvocation }));
    event.systemPromptOptions.skills = [];
    if (event.messageType !== "user" || !event.prompt.trim() || /^\/\S/.test(event.prompt.trim())
      || /^<skill name="[^"]+" location="/.test(event.prompt.trim())) return;
    let library: FileSkill[] = [];
    try {
      const roots = process.env.SKILL_GATEWAY_ROOT ? [process.env.SKILL_GATEWAY_ROOT] : defaultRoots();
      library = loadMerged(roots).map(({ document: d }) => ({ name: d.name, description: d.originalDescription ?? d.description, filePath: join(d.path, "SKILL.md") }));
    } catch { /* Native skills are still available if the library cannot be scanned. */ }
    const roster = [...new Map([...library, ...native].map((s) => [s.name, s])).values()];
    const session = ctx.sessionManager.getSessionId(), turn = randomUUID(), current = generation;
    const answer = await chooser.suggest(event.prompt, roster, ctx.cwd);
    if (current !== generation) return;
    audit(event.prompt, session, turn, roster, answer);
    ctx.ui.setStatus("jev-skill-suggestion", answer.name ? `Jev original: ${answer.name}` : "Jev original: no skill");
    if (!answer.context) return;
    return { message: { customType: "jev-skill-suggestion", content: answer.context, display: false,
      details: { runtime_policy: JEV_UPSTREAM_POLICY, session_id: session, turn_id: turn, skill: answer.name, inline: answer.inline } } };
  });
}

function audit(prompt: string, session: string, turn: string, roster: FileSkill[], answer: JevSuggestion): void {
  const selected = answer.name ? [answer.name] : [];
  const status = !roster.length ? "no_candidates" : !answer.wide ? "error" : answer.name ? "pass" : "reject";
  const payload = { agent: "pi", session_id: session, turn_id: turn, turn_id_source: "pi_jev_extension" };
  const gate: GateAudit = { status, model: DEFAULT_MODEL.typesafe, probability: answer.wide?.gate ?? null, candidates: roster.map((s) => s.name), reason: answer.reason };
  try { noteFollowup(session, prompt); record(payload, prompt, selected, process.env, gate); } catch { /* Best-effort local query log. */ }
  try {
    const reported = answer.requests.length > 0 && answer.requests.every((r) => r.input_tokens !== null);
    appendUsageEvent({ event_type: "gate_decision", ...payload, platform: "pi", user_id: userId(payload),
      runtime_policy: JEV_UPSTREAM_POLICY, prompt_sha256: promptDigest(prompt), candidate_names: gate.candidates,
      candidate_rankings: answer.wide?.ranked.map((r, i) => ({ name: r.name, rank: i + 1, search_score: null })) ?? [],
      gate_status: status, gate_model: gate.model, probability: gate.probability, threshold: JEV_UPSTREAM_DEFAULTS.gateThreshold,
      injected_skill_names: selected, injection_kind: answer.inline ? "inline_body" : answer.name ? "already_loaded_or_file_reference" : "none",
      request_attempted: answer.requests.length > 0, requests: answer.requests,
      estimated_input_tokens: answer.requests.reduce((sum, r) => sum + r.estimated_input_tokens, 0),
      ...(reported ? { input_tokens: answer.requests.reduce((sum, r) => sum + r.input_tokens!, 0) } : {}),
      input_tokens_source: reported ? "typesafe_usage" : answer.requests.length ? "estimated_utf8_bytes_div_4" : "not_sent",
      jev_list_cost_usd: answer.requests.length ? answer.requests.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0) : null,
      cost_basis: !answer.requests.length ? "not_sent" : reported ? "reported_input_tokens" : "estimated_input_tokens",
      cost_rate_usd_per_million_input_tokens: SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS,
      latency_ms: answer.latency_ms, reason: answer.reason,
    });
  } catch { /* Do not block a prompt if telemetry is unavailable. */ }
}
