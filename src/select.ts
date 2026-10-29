import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JevSkillSuggestion, JEV_UPSTREAM_DEFAULTS, JEV_UPSTREAM_POLICY, type FileSkill, type JevSuggestion } from "./jev-skill-suggestion.ts";
import { readTypeSafeKey } from "./secrets.ts";
import { defaultRoots, loadMerged } from "./search.ts";
import { appendUsageEvent, promptDigest } from "./usage-events.ts";

/**
 * One provider-neutral skill selection for one user message.
 *
 * BB owns the decision and calls this through the plugin; Pi only suppresses its
 * native roster and injects the returned context. Keeping the policy here means
 * every host runs the same Jev selection instead of a per-harness copy.
 */
export type SelectRequest = {
  prompt: string;
  /** Working directory the skill body may reference as ${CLAUDE_PROJECT_DIR}. */
  cwd?: string;
  /** Library root; defaults to the gateway's standard roots. */
  root?: string;
  /** Skill names already injected in this session. */
  loaded?: string[];
  /** Host that asked, recorded in the gate ledger. */
  platform?: string;
  /** Host session identity, recorded in the gate ledger. */
  sessionId?: string;
  /** Thread the host showed this turn in, recorded so the dashboard can find it again. */
  threadId?: string;
  /** Explicit roster; defaults to the library. Paths must be readable by this process. */
  roster?: RosterSkill[];
};

export type RosterSkill = {
  name: string;
  description?: string;
  filePath: string;
  disableModelInvocation?: boolean;
};

export type SelectResult = {
  name: string | null;
  context: string;
  reason: string;
  inline: boolean;
  latency_ms: number;
  /** Candidates considered, so a host can report a gate decision without rescanning. */
  candidates: string[];
  requests: JevSuggestion["requests"];
};

export type SelectDependencies = {
  apiKey?: string | null;
  fetcher?: typeof fetch;
  /** Tests and embedding hosts disable the ledger row; the default records it. */
  record?: boolean;
  /** Roster provider, replacing the on-disk library when a host resolves skills itself. */
  roster?: RosterSkill[];
};

export function libraryRoster(root?: string): RosterSkill[] {
  const roots = root ? [root] : defaultRoots();
  return loadMerged(roots).map(({ document }) => ({
    name: document.name,
    description: document.originalDescription ?? document.description,
    filePath: join(document.path, "SKILL.md"),
  }));
}

export async function selectSkill(
  request: SelectRequest,
  dependencies: SelectDependencies = {},
): Promise<SelectResult> {
  const roster: FileSkill[] = (request.roster ?? dependencies.roster ?? libraryRoster(request.root)).map(
    (skill) => ({
      name: skill.name,
      description: skill.description ?? "",
      filePath: skill.filePath,
      ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
    }),
  );
  let apiKey = dependencies.apiKey;
  if (apiKey === undefined) {
    try {
      apiKey = readTypeSafeKey();
    } catch {
      apiKey = null;
    }
  }
  const chooser = new JevSkillSuggestion({
    allowSkillExcerpts: true,
    apiKey,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    ...(request.loaded ? { loaded: request.loaded } : {}),
  });
  const suggestion = await chooser.suggest(request.prompt, roster, request.cwd ?? process.cwd());
  if (dependencies.record !== false) record(request, suggestion, roster.map((skill) => skill.name));
  return {
    name: suggestion.name,
    context: suggestion.context,
    reason: suggestion.reason,
    inline: suggestion.inline,
    latency_ms: suggestion.latency_ms,
    candidates: roster.map((skill) => skill.name),
    requests: suggestion.requests,
  };
}

/**
 * One ledger row per selection, whichever host asked. The dashboard reads
 * these back; a failure here never changes the decision.
 */
function record(request: SelectRequest, suggestion: JevSuggestion, candidates: string[]): void {
  const status = candidates.length === 0 ? "no_candidates" : !suggestion.wide ? "error" : suggestion.name ? "pass" : "reject";
  const injected = suggestion.name ? [suggestion.name] : [];
  const reported = suggestion.requests.length > 0 && suggestion.requests.every((entry) => entry.input_tokens !== null);
  const tokens = suggestion.requests.reduce((sum, entry) => sum + (entry.input_tokens ?? entry.estimated_input_tokens), 0);
  try {
    appendUsageEvent({
      event_type: "gate_decision",
      platform: request.platform ?? "unknown",
      session_id: request.sessionId ?? null,
      thread_id: request.threadId ?? null,
      turn_id: null,
      runtime_policy: JEV_UPSTREAM_POLICY,
      prompt_sha256: promptDigest(request.prompt),
      candidate_names: candidates,
      gate_status: status,
      gate_model: suggestion.wide ? "jev-latest" : null,
      probability: suggestion.wide?.gate ?? null,
      threshold: JEV_UPSTREAM_DEFAULTS.gateThreshold,
      injected_skill_names: injected,
      injection_kind: suggestion.inline ? "inline_body" : suggestion.name ? "already_loaded_or_file_reference" : "none",
      request_attempted: suggestion.requests.length > 0,
      ...(reported ? { input_tokens: tokens } : {}),
      estimated_input_tokens: tokens,
      input_tokens_source: reported ? "typesafe_usage" : suggestion.requests.length ? "estimated_utf8_bytes_div_4" : "not_sent",
      latency_ms: Math.max(0, Math.round(suggestion.latency_ms)),
      reason: suggestion.reason,
      // Why a call failed, beyond "no answer": a timeout, an HTTP error and a
      // malformed reply all looked identical in the ledger before this.
      requests: suggestion.requests.map((entry) => ({
        phase: entry.phase,
        status: entry.status,
        reason: entry.reason ?? null,
        latency_ms: Math.max(0, Math.round(entry.latency_ms)),
      })),
    });
  } catch {
    // Telemetry is best-effort; selection still returns its answer.
  }
}

export async function selectFromStdin(
  input: string,
  dependencies: SelectDependencies = {},
): Promise<SelectResult> {
  const parsed: unknown = JSON.parse(input || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  const request = parsed as Record<string, unknown>;
  if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("prompt is required");
  return selectSkill(
    {
      prompt: request.prompt,
      ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
      ...(typeof request.root === "string" ? { root: request.root } : {}),
      ...(isStringArray(request.loaded) ? { loaded: request.loaded } : {}),
      ...(typeof request.platform === "string" ? { platform: request.platform } : {}),
      ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
      ...(typeof request.threadId === "string" ? { threadId: request.threadId } : {}),
      ...(isRoster(request.roster) ? { roster: request.roster } : {}),
    },
    dependencies,
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRoster(value: unknown): value is RosterSkill[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as RosterSkill).name === "string" &&
        typeof (entry as RosterSkill).filePath === "string",
    )
  );
}

async function main(): Promise<void> {
  try {
    const result = await selectFromStdin(readFileSync(0, "utf8"));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ name: null, context: "", reason: `error: ${errorMessage(error)}`, inline: false, latency_ms: 0, candidates: [], requests: [] }));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (/^select\.(ts|js)$/.test(process.argv[1]?.split("/").pop() ?? "")) {
  void main();
}
