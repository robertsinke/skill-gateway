import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DEFAULT_LOG } from "./query-log.ts";
import { DEFAULT_USAGE_EVENTS } from "./usage-events.ts";
import {
  summarizeSkillUsageFeedback,
  type ShortlistRating,
  type SkillUsageFeedbackRecord,
  type SkillUsageFeedbackSummary,
} from "./skill-usage-feedback-record.ts";
import { buildUsageTurnDataset, readJsonl } from "./usage-turn-dataset.ts";

export { type ShortlistRating, type SkillUsageFeedbackRecord, type SkillUsageFeedbackSummary } from "./skill-usage-feedback-record.ts";
export const DEFAULT_SKILL_USAGE_FEEDBACK = `${homedir()}/.local/share/skill-gateway/skill-usage-feedback.jsonl`;

export type SearchSkillUsageTurnsInput = {
  query?: string;
  user_id?: string | null;
  session_id?: string;
  turn_id?: string;
  limit?: number;
};

export type UpdateSkillUsageFeedbackInput = {
  user_id: string | null;
  session_id: string;
  turn_id: string;
  shortlist_rating?: ShortlistRating | null;
  should_not_inject_skill_names?: string[];
  should_not_load_skill_names?: string[];
  comment?: string;
  comment_source?: "user_verbatim" | "assistant_paraphrase";
};

function paths(env: NodeJS.ProcessEnv) {
  return {
    events: env.SKILL_GATEWAY_EVENTS ?? DEFAULT_USAGE_EVENTS,
    queries: env.SKILL_GATEWAY_LOG ?? DEFAULT_LOG,
    feedback: env.SKILL_GATEWAY_FEEDBACK ?? DEFAULT_SKILL_USAGE_FEEDBACK,
  };
}

export function searchSkillUsageTurns(
  input: SearchSkillUsageTurnsInput = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const { events, queries, feedback } = paths(env);
  const dataset = buildUsageTurnDataset(readJsonl(events), readJsonl(queries), readJsonl(feedback));
  const needle = input.query?.trim().toLocaleLowerCase() ?? "";
  const turns = dataset.rows.filter((row) => {
    if (row.gate_decisions.length === 0 && row.verified_load_count === 0) return false;
    if (input.session_id !== undefined && row.session_id !== input.session_id) return false;
    if (input.turn_id !== undefined && row.turn_id !== input.turn_id) return false;
    if (input.user_id !== undefined && row.user_id !== input.user_id) return false;
    if (!needle) return true;
    const searchable = [
      row.query ?? "",
      ...row.injected_skill_names,
      ...row.loaded_skill_names,
      ...row.gate_decisions.flatMap((gate) => gate.candidate_names),
    ].join("\n").toLocaleLowerCase();
    return searchable.includes(needle);
  });
  turns.sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""));
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 10)));
  const results = turns.slice(0, limit).map((row) => ({
    user_id: row.user_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    turn_id_sources: row.turn_id_sources,
    platform: row.platform,
    observed_at: row.observed_at,
    query_match_status: row.query_match_status,
    query_present: row.query !== null,
    gate_decisions: row.gate_decisions.map((gate) => ({
      status: gate.status,
      probability: gate.probability,
      threshold: gate.threshold,
      candidate_names: gate.candidate_names,
      injected_skill_names: gate.injected_skill_names,
      input_tokens: gate.input_tokens,
      jev_list_cost_usd: gate.jev_list_cost_usd,
    })),
    loaded_skill_names: row.loaded_skill_names,
    loaded_injected_skill_names: row.loaded_injected_skill_names,
    loaded_not_injected_skill_names: row.loaded_not_injected_skill_names,
    feedback: row.feedback ? summarizeSkillUsageFeedback(row.feedback) : null,
  }));
  return { total: turns.length, count: results.length, results };
}

export function updateSkillUsageFeedback(
  input: UpdateSkillUsageFeedbackInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { events, queries, feedback } = paths(env);
  if (!input.session_id.trim() || !input.turn_id.trim()) throw new Error("session_id and turn_id are required");
  if (input.shortlist_rating !== undefined && input.shortlist_rating !== null
    && input.shortlist_rating !== "helpful" && input.shortlist_rating !== "not_helpful") {
    throw new Error("shortlist_rating must be helpful, not_helpful, or null");
  }
  const dataset = buildUsageTurnDataset(readJsonl(events), readJsonl(queries), readJsonl(feedback));
  const turn = dataset.rows.find((row) =>
    row.user_id === input.user_id && row.session_id === input.session_id && row.turn_id === input.turn_id,
  );
  if (!turn) throw new Error("No exact linked turn found for this user_id, session_id, and turn_id; do not infer a turn from session_id alone.");

  const prior = turn.feedback;
  const injectedSkillNames = input.should_not_inject_skill_names === undefined
    ? prior?.should_not_inject_skill_names ?? []
    : [...new Set(input.should_not_inject_skill_names.map((name) => name.trim()).filter(Boolean))];
  const unobservedInjections = injectedSkillNames.filter((name) => !turn.injected_skill_names.includes(name));
  if (unobservedInjections.length) throw new Error(`These skills were not injected on this turn: ${unobservedInjections.join(", ")}`);
  const skillNames = input.should_not_load_skill_names === undefined
    ? prior?.should_not_load_skill_names ?? []
    : [...new Set(input.should_not_load_skill_names.map((name) => name.trim()).filter(Boolean))];
  const unobservedLoads = skillNames.filter((name) => !turn.loaded_skill_names.includes(name));
  if (unobservedLoads.length) throw new Error(`These skills were not verified as loaded on this turn: ${unobservedLoads.join(", ")}`);

  const shortlistRating = input.shortlist_rating === undefined ? prior?.shortlist_rating ?? null : input.shortlist_rating;
  const comment = input.comment === undefined ? prior?.comment ?? null : input.comment.trim() || null;
  const commentSource = input.comment === undefined
    ? prior?.comment_source ?? null
    : comment ? input.comment_source ?? null : null;
  if (comment && !commentSource) throw new Error("Set comment_source to user_verbatim or assistant_paraphrase when recording a comment.");
  if (!prior && injectedSkillNames.length === 0 && skillNames.length === 0 && shortlistRating === null && comment === null) {
    throw new Error("Provide a shortlist rating, comment, or at least one exact unwanted injected/loaded skill name.");
  }
  if (prior
    && JSON.stringify(prior.should_not_inject_skill_names) === JSON.stringify(injectedSkillNames)
    && JSON.stringify(prior.should_not_load_skill_names) === JSON.stringify(skillNames)
    && prior.shortlist_rating === shortlistRating
    && prior.comment === comment
    && prior.comment_source === commentSource) {
    return { status: "unchanged" as const, feedback: summarizeSkillUsageFeedback(prior) };
  }

  const record: SkillUsageFeedbackRecord = {
    schema_version: 2,
    event_type: "skill_usage_feedback",
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    user_id: input.user_id,
    session_id: input.session_id,
    turn_id: input.turn_id,
    shortlist_rating: shortlistRating,
    should_not_inject_skill_names: injectedSkillNames,
    should_not_load_skill_names: skillNames,
    comment,
    comment_source: commentSource,
  };
  mkdirSync(dirname(feedback), { recursive: true, mode: 0o700 });
  appendFileSync(feedback, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(feedback, 0o600);
  return { status: prior ? "updated" as const : "created" as const, feedback: summarizeSkillUsageFeedback(record) };
}
