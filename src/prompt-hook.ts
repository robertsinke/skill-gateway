import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { noteFollowup, record, sessionId, userId } from "./query-log.ts";
import type { GateAudit } from "./query-log.ts";
import { evaluateSkillGate, SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS, SKILL_GATE_MODEL, SKILL_GATE_THRESHOLD, skillGateListCostUsd, skillGateRequestMetrics, type GateDecision } from "./skill-gate.ts";
import { appendUsageEvent, promptDigest } from "./usage-events.ts";
import { search, searchRoots, defaultRoots, SearchError } from "./search.ts";
import { CONSERVATIVE_RERANK_TRIAL, evaluateSkillRerank, type RerankResult } from "./skill-rerank.ts";

const LIMIT = parseLimit(process.env.SKILL_GATEWAY_LIMIT, 5);

const ANOTHER_SEARCH = `To search this library again during this same user message, run:
node ~/.local/share/skill-gateway/dist/search.js "<query>" --limit 10
When the user names a skill, run:
node ~/.local/share/skill-gateway/dist/search.js --exact "<name>"
Pass the query in the user's words. An empty result means load no library skill.
If this conversation already loaded a listed skill, reuse it instead of reading it again.
Read a skill file only when the task matches and it has not been loaded earlier in this conversation.`;

type Hit = { name?: unknown; path?: unknown; description?: unknown; score?: unknown };

function empty(): void {
  console.log(
    JSON.stringify({
      systemMessage: "",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "",
      },
    }),
  );
}

export function formatShortlist(results: Hit[]): string {
  const lines = ["Skill library shortlist. Load a library skill only from this list."];
  results.forEach((hit, index) => {
    const name = String(hit.name ?? "").trim();
    const path = String(hit.path ?? "").trim();
    const description = String(hit.description ?? "").trim();
    if (!name || !path) return;
    lines.push(`- ${index + 1}. ${name} — ${path} — ${description}`);
  });
  const body = lines.length === 1 ? ["Skill library shortlist is empty. Load no library skill from this search."] : lines;
  return `${body.join("\n")}\n\n${ANOTHER_SEARCH}`;
}

function isPi(payload: Record<string, unknown>): boolean {
  if (payload.agent === "pi") return true;
  for (const key of ["transcript_path", "transcriptPath"]) {
    const value = payload[key];
    if (typeof value === "string" && value.replaceAll("\\", "/").includes("/.pi/")) return true;
  }
  return false;
}

function searchPrompt(prompt: string, env: NodeJS.ProcessEnv): Hit[] {
  const override = (env.SKILL_GATEWAY_ROOT ?? "").trim();
  if (override) return search(override, prompt, LIMIT);
  return searchRoots(defaultRoots(), prompt, LIMIT);
}

export type GateEvaluator = (prompt: string, candidates: { name: string; description: string }[]) => Promise<GateDecision>;
export type RerankEvaluator = typeof evaluateSkillRerank;

export async function handle(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  evaluateGate: GateEvaluator = evaluateSkillGate,
  evaluateRerank: RerankEvaluator = evaluateSkillRerank,
): Promise<string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return emptyJson();
  const recordPayload = payload as Record<string, unknown>;
  const prompt = recordPayload.prompt !== undefined && recordPayload.prompt !== null ? recordPayload.prompt : recordPayload.userPrompt;
  if (typeof prompt !== "string" || !prompt.trim()) return emptyJson();
  // The opt-in native Pi chooser owns this session; never run two selectors on the same prompt.
  const piSession = sessionId(recordPayload);
  if (isPi(recordPayload) && piSession && piSession === env.SKILL_GATEWAY_PI_JEV_SESSION) return emptyJson();
  let results: Hit[];
  try {
    results = searchPrompt(prompt, env);
  } catch (error) {
    if (error instanceof SearchError) return emptyJson();
    throw error;
  }

  const promptText = prompt.trim();
  const gateStartedAt = Date.now();
  const gateResults = results.slice(0, 5);
  const gateCandidates = gateResults.map((hit) => ({
    name: String(hit.name ?? "").trim(),
    description: String(hit.description ?? "").trim(),
  })).filter((candidate) => candidate.name);
  const disabled = env.SKILL_GATEWAY_GATE_MODE?.trim().toLowerCase() === "off";
  const rerankMode = env.SKILL_GATEWAY_RERANK_MODE?.trim().toLowerCase();
  const session = sessionId(recordPayload);
  const experimentArm = rerankMode === "experiment" && session
    ? (Number.parseInt(createHash("sha256").update(session).digest("hex").slice(0, 8), 16) % 2 === 0 ? "control" : "treatment")
    : null;
  let rerankOutcome: RerankResult | undefined;
  let gate: GateAudit;
  let requestAttempted = false;
  let decision: GateDecision | undefined;
  let injectedResults: Hit[] = [];
  if (results.length === 0) {
    gate = { status: "no_candidates", model: null, probability: null, candidates: [] };
  } else if (disabled) {
    gate = { status: "bypassed", model: null, probability: null, candidates: gateCandidates.map((candidate) => candidate.name) };
    injectedResults = results;
  } else {
    try {
      decision = await evaluateGate(promptText, gateCandidates);
    } catch {
      decision = { status: "error", probability: null, model: SKILL_GATE_MODEL, reason: "gate_exception", request_attempted: true };
    }
    requestAttempted = decision.request_attempted ?? true;
    gate = {
      status: decision.status,
      model: decision.model,
      probability: decision.probability,
      candidates: gateCandidates.map((candidate) => candidate.name),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
    if (decision.status === "pass") injectedResults = gateResults;
  }

  const gateLatencyMs = Math.max(0, Date.now() - gateStartedAt);
  // Shadow measures without changing injection; experiment randomly assigns stable sessions to treatment/control.
  if ((rerankMode === "shadow" || (rerankMode === "experiment" && experimentArm === "treatment")) && decision?.status === "pass" && gateCandidates.length > 0) {
    let rerank: RerankResult;
    try {
      rerank = await evaluateRerank(promptText, gateCandidates, {
        judgment: CONSERVATIVE_RERANK_TRIAL.judgment, threshold: CONSERVATIVE_RERANK_TRIAL.threshold,
      });
    } catch {
      rerank = { status: "error", reason: "rerank_exception", fits: [], selected: [], request_attempted: true, estimated_input_tokens: 0, cost_usd: null, latency_ms: 0 };
    }
    rerankOutcome = rerank;
    if (rerankMode === "experiment" && experimentArm === "treatment" && rerank.status === "ok") {
      const selected = new Set(rerank.selected);
      injectedResults = gateResults.filter((hit) => selected.has(String(hit.name ?? "").trim()));
    }
    try {
      appendUsageEvent({
        event_type: rerankMode === "experiment" ? "skill_rerank_experiment" : "skill_rerank_shadow",
        experiment_arm: experimentArm,
        rerank_policy: CONSERVATIVE_RERANK_TRIAL.id,
        rerank_judgment: CONSERVATIVE_RERANK_TRIAL.judgment,
        rerank_threshold: CONSERVATIVE_RERANK_TRIAL.threshold,
        user_id: userId(recordPayload, env),
        session_id: sessionId(recordPayload),
        turn_id: typeof recordPayload.turn_id === "string" ? recordPayload.turn_id : typeof recordPayload.turnId === "string" ? recordPayload.turnId : null,
        prompt_sha256: promptDigest(promptText),
        candidate_names: gateCandidates.map((candidate) => candidate.name),
        selected_names: rerank.selected,
        fits: rerank.fits,
        status: rerank.status,
        ...(rerank.reason ? { reason: rerank.reason } : {}),
        request_attempted: rerank.request_attempted,
        input_tokens: rerank.input_tokens ?? null,
        output_tokens: rerank.output_tokens ?? null,
        estimated_input_tokens: rerank.estimated_input_tokens,
        input_tokens_source: rerank.input_tokens !== undefined ? "typesafe_usage" : rerank.request_attempted ? "estimated_chars_div_4" : "not_sent",
        cost_usd: rerank.cost_usd,
        cost_rate_usd_per_million_input_tokens: SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS,
        latency_ms: rerank.latency_ms,
      }, env);
    } catch {
      // Telemetry is best-effort; shadow evaluation never changes live injection.
    }
  }

  const injectedNames = injectedResults.map((hit) => String(hit.name ?? "").trim()).filter(Boolean);
  try {
    noteFollowup(sessionId(recordPayload), promptText, env);
    record(recordPayload, promptText, injectedNames, env, gate);
  } catch {
    // The query log is best-effort. Injection still follows the gate decision.
  }
  try {
    const turnId = typeof recordPayload.turn_id === "string" ? recordPayload.turn_id : typeof recordPayload.turnId === "string" ? recordPayload.turnId : null;
    const turnIdSource = typeof recordPayload.turn_id_source === "string" ? recordPayload.turn_id_source : turnId ? "host_payload" : null;
    const platform = typeof recordPayload.agent === "string" ? recordPayload.agent : null;
    const requestMetrics = !disabled && gateCandidates.length > 0 ? skillGateRequestMetrics(promptText, gateCandidates) : null;
    const candidateRankings = gateResults.map((hit, index) => ({
      rank: index + 1,
      name: String(hit.name ?? "").trim(),
      search_score: typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : null,
    })).filter((candidate) => candidate.name);
    const costTokens = decision?.input_tokens ?? (requestAttempted ? requestMetrics?.estimated_input_tokens : undefined);
    const jevListCost = requestAttempted && typeof costTokens === "number" ? skillGateListCostUsd(costTokens) : null;
    const costBasis = !requestAttempted ? "not_sent"
      : decision?.input_tokens !== undefined ? "reported_input_tokens"
        : typeof costTokens === "number" ? "estimated_input_tokens" : "unavailable";
    appendUsageEvent({
      event_type: "gate_decision",
      experiment_arm: experimentArm,
      rerank_policy: rerankMode === "experiment" || rerankMode === "shadow" ? CONSERVATIVE_RERANK_TRIAL.id : null,
      rerank_judgment: rerankMode === "experiment" || rerankMode === "shadow" ? CONSERVATIVE_RERANK_TRIAL.judgment : null,
      rerank_threshold: rerankMode === "experiment" || rerankMode === "shadow" ? CONSERVATIVE_RERANK_TRIAL.threshold : null,
      rerank_status: rerankOutcome?.status ?? null,
      rerank_selected_names: rerankOutcome?.selected ?? null,
      user_id: userId(recordPayload, env),
      session_id: sessionId(recordPayload),
      turn_id: turnId,
      turn_id_source: turnIdSource,
      platform,
      prompt_sha256: promptDigest(promptText),
      candidate_names: gate.candidates,
      candidate_rankings: candidateRankings,
      gate_status: gate.status,
      gate_model: gate.model,
      probability: gate.probability,
      threshold: SKILL_GATE_THRESHOLD,
      injected_skill_names: injectedNames,
      request_attempted: requestAttempted,
      ...(requestMetrics ? requestMetrics : {}),
      ...(decision?.input_tokens !== undefined ? { input_tokens: decision.input_tokens } : {}),
      ...(decision?.output_tokens !== undefined ? { output_tokens: decision.output_tokens } : {}),
      input_tokens_source: decision?.input_tokens !== undefined ? "typesafe_usage" : requestAttempted ? "estimated_chars_div_4" : "not_sent",
      jev_list_cost_usd: jevListCost,
      cost_basis: costBasis,
      cost_rate_usd_per_million_input_tokens: SKILL_GATE_INPUT_PRICE_USD_PER_MILLION_TOKENS,
      cost_rate_source: "https://docs.typesafe.ai/models.md",
      latency_ms: gateLatencyMs,
      ...(gate.reason ? { reason: gate.reason } : {}),
    }, env);
  } catch {
    // The event ledger is best-effort and must not affect prompt injection.
  }

  if (injectedResults.length === 0) return emptyJson();
  const text = formatShortlist(injectedResults);
  let systemMessage: string;
  if (isPi(recordPayload)) systemMessage = "";
  else if (recordPayload.turn_id) systemMessage = text;
  else systemMessage = `${promptText}\n\n${text}`;
  return JSON.stringify({
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });
}

function emptyJson(): string {
  return JSON.stringify({
    systemMessage: "",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "",
    },
  });
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 20) : fallback;
}

async function main(): Promise<void> {
  try {
    const raw = readFileSync(0, "utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      empty();
      return;
    }
    console.log(await handle(payload));
  } catch {
    empty();
  }
}

if (basename(process.argv[1] ?? "") === "prompt-hook.ts" || basename(process.argv[1] ?? "") === "prompt-hook.js") {
  main();
}
