import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readTypeSafeKey } from "./secrets.ts";
import { skillGateListCostUsd } from "./skill-gate.ts";
import {
  DEFAULT_BASE_URL, DEFAULT_MODEL, bodyOf, catalog, decide, detailOf, endpoint,
  modelInvocable, passesGate, readRerank, readWide, requestBody, requestHeaders,
  rerankQuestions, shortlistOf, wideQuestions,
  type Rerank, type Skill, type Wide,
} from "./vendor/jev-skill-suggestion/policy.ts";

export const JEV_UPSTREAM_REVISION = "4efb68547887d2a4dd714074bd7ecb4171dc9fee";
export const JEV_UPSTREAM_POLICY = `jev-skill-suggestion@${JEV_UPSTREAM_REVISION}`;
export const JEV_UPSTREAM_DEFAULTS = Object.freeze({ shortlist: 3, gateThreshold: 0.3, fitsThreshold: 0.3, excerptChars: 700, timeoutMs: 800 });
export type FileSkill = Skill & { filePath: string; disableModelInvocation?: boolean };
export type JevRequest = {
  phase: "ranking" | "rerank"; status: "ok" | "error"; reason?: string;
  latency_ms: number; estimated_input_tokens: number; input_tokens: number | null;
  output_tokens: number | null; cost_usd: number | null;
};
export type JevSuggestion = {
  name: string | null; context: string; reason: string; wide: Wide | null; rerank: Rerank | null;
  requests: JevRequest[]; latency_ms: number; inline: boolean;
};
type Options = { allowSkillExcerpts: boolean; apiKey?: string | null; fetcher?: typeof fetch };

/** The TypeSafe path of the original add-on. Only transport, files and Pi's loading text differ. */
export class JevSkillSuggestion {
  private readonly files = new Map<string, Promise<string | null>>();
  private readonly injected = new Set<string>();
  private generation = 0;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }

  reset(): void { this.generation++; this.files.clear(); this.injected.clear(); }

  private body(skill: FileSkill): Promise<string | null> {
    let value = this.files.get(skill.filePath);
    if (!value) {
      value = readFile(skill.filePath, "utf8").catch(() => null);
      this.files.set(skill.filePath, value);
    }
    return value;
  }

  async suggest(prompt: string, roster: readonly FileSkill[], cwd: string): Promise<JevSuggestion> {
    const started = Date.now(), generation = this.generation;
    const result: JevSuggestion = { name: null, context: "", reason: "no answer", wide: null, rerank: null, requests: [], latency_ms: 0, inline: false };
    const finish = () => { result.latency_ms = Date.now() - started; return result; };
    if (!this.options.allowSkillExcerpts) { result.reason = "skill_excerpt_permission_required"; return finish(); }
    // Pi expands an explicit /skill:name before before_agent_start. Do not select another skill over it.
    if (!prompt.trim() || /^\/\S/.test(prompt.trim()) || /^<skill name="[^"]+" location="/.test(prompt.trim())) {
      result.reason = "not_an_implicit_skill_request"; return finish();
    }
    const skills = catalog(roster.map((s) => ({ ...s, source: "skill" })), new Set(), new Set());
    const paths = new Map<string, FileSkill>();
    for (const skill of roster) if (!paths.has(skill.name)) paths.set(skill.name, skill);
    if (!skills.length) { result.reason = "no_candidates"; return finish(); }
    let apiKey: string | null;
    try { apiKey = this.options.apiKey === undefined ? readTypeSafeKey() : this.options.apiKey; } catch { apiKey = null; }
    if (!apiKey) { result.reason = "credential_unavailable"; return finish(); }

    const ask = async (phase: JevRequest["phase"], questions: Record<string, unknown>): Promise<string | null> => {
      const body = requestBody("typesafe", prompt, questions, DEFAULT_MODEL.typesafe);
      const audit: JevRequest = { phase, status: "error", latency_ms: 0,
        estimated_input_tokens: Math.ceil(Buffer.byteLength(body, "utf8") / 4), input_tokens: null, output_tokens: null, cost_usd: null };
      result.requests.push(audit);
      const before = Date.now();
      try {
        const response = await (this.options.fetcher ?? fetch)(endpoint("typesafe", DEFAULT_BASE_URL.typesafe), {
          method: "POST", headers: requestHeaders("typesafe", apiKey!, DEFAULT_MODEL.typesafe), body,
          signal: AbortSignal.timeout(JEV_UPSTREAM_DEFAULTS.timeoutMs),
        });
        if (!response.ok) { audit.reason = `http_${response.status}`; return null; }
        const text = await response.text();
        const parsed: unknown = JSON.parse(text);
        if (!validResponse(parsed)) { audit.reason = "invalid_response"; return null; }
        if (!(phase === "ranking" ? readWide(text) : readRerank(text))) { audit.reason = "invalid_answers"; return null; }
        const usage = parsed.usage;
        if (isRecord(usage)) {
          audit.input_tokens = tokens(usage.input_tokens); audit.output_tokens = tokens(usage.output_tokens);
        }
        audit.status = "ok";
        return text;
      } catch (error) {
        audit.reason = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "request_failed";
        return null;
      } finally {
        audit.latency_ms = Date.now() - before;
        audit.cost_usd = skillGateListCostUsd(audit.input_tokens ?? audit.estimated_input_tokens);
      }
    };

    const first = await ask("ranking", wideQuestions("typesafe", skills));
    if (generation !== this.generation) { result.reason = "context_changed"; return finish(); }
    result.wide = first ? readWide(first) : null;
    const barred = new Set<string>();
    let rerankAttempted = false;
    if (result.wide && passesGate(result.wide, JEV_UPSTREAM_DEFAULTS)) {
      const candidates = [];
      for (const skill of shortlistOf(result.wide, skills, JEV_UPSTREAM_DEFAULTS.shortlist)) {
        const source = paths.get(skill.name)!;
        if (source.disableModelInvocation) { barred.add(skill.name); continue; }
        const markdown = await this.body(source);
        if (!modelInvocable(markdown)) { barred.add(skill.name); continue; }
        candidates.push({ ...skill, detail: detailOf(skill, markdown, JEV_UPSTREAM_DEFAULTS.excerptChars) });
      }
      if (generation !== this.generation) { result.reason = "context_changed"; return finish(); }
      if (candidates.length) {
        rerankAttempted = true;
        const answer = await ask("rerank", rerankQuestions("typesafe", candidates));
        result.rerank = answer ? readRerank(answer) : null;
      }
    }
    if (generation !== this.generation) { result.reason = "context_changed"; return finish(); }
    const offered = skills.filter((s) => !barred.has(s.name));
    const decision = decide(result.wide, result.rerank, offered, JEV_UPSTREAM_DEFAULTS, rerankAttempted);
    result.reason = decision.reason;
    const pick = decision.name ? paths.get(decision.name) : undefined;
    if (!pick) return finish();
    const markdown = await this.body(pick);
    if (generation !== this.generation) { result.reason = "context_changed"; return finish(); }
    if (pick.disableModelInvocation || !modelInvocable(markdown)) { result.reason = "disable-model-invocation"; return finish(); }
    result.name = pick.name;
    result.context = piInjection(pick, markdown, cwd, this.injected.has(pick.filePath));
    result.inline = !!markdown && !this.injected.has(pick.filePath);
    if (markdown) this.injected.add(pick.filePath);
    return finish();
  }
}

function piInjection(skill: FileSkill, markdown: string | null, cwd: string, loaded: boolean): string {
  const lines = ["<skill_relevance>", `Relevant to the current request: ${skill.name}. Ignore this if it does not fit what the user actually asked for.`];
  if (loaded) lines.push(`Skill /${skill.name} is already loaded above; instructions unchanged.`);
  else if (markdown) {
    const dir = dirname(skill.filePath);
    const body = bodyOf(markdown).replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => dir).replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => cwd);
    lines.push(`Its instructions follow: follow them now, including any setup steps. They are already loaded here; do not read the skill file again. Its files are in ${dir}.`,
      `<skill name="${xml(skill.name)}" dir="${xml(dir)}">`, body, "</skill>");
  } else lines.push(`${skill.name}: ${skill.description}`, `Read ${skill.filePath} to load this skill before starting. If it is unavailable, tell the user.`);
  lines.push("</skill_relevance>"); return lines.join("\n");
}
function xml(text: string): string { return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function tokens(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
/** Reject malformed wire values without changing the upstream policy for valid answers (including missing optional answers). */
function validResponse(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.answers)) return false;
  for (const answer of Object.values(value.answers)) {
    if (!isRecord(answer)) return false;
    for (const key of ["noul", "probability", "confidence"]) {
      const p = answer[key];
      if (p != null && (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)) return false;
    }
    if (answer.probabilities != null && (!isRecord(answer.probabilities)
      || Object.values(answer.probabilities).some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1))) return false;
  }
  return true;
}
