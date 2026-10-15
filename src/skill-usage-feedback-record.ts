export type SkillRelevance = "relevant" | "not_relevant" | "unsure";
export type SkillRelevanceLabel = { skill_name: string; relevance: SkillRelevance };
export type SkillNeed = "yes" | "no" | "unsure";
export type InjectionDecision = "yes" | "no" | "unsure";
export type ShortlistRating = "helpful" | "not_helpful";

export type SkillUsageFeedbackRecord = {
  schema_version: 5;
  event_type: "skill_usage_feedback";
  event_id: string;
  timestamp: string;
  user_id: string | null;
  session_id: string;
  turn_id: string;
  user_skill_feedback: SkillRelevanceLabel[];
  injection_decision: InjectionDecision | null;
  /** Legacy coarse labels are preserved, but the new UI does not collect them. */
  legacy_skill_need: SkillNeed | null;
  legacy_relevant_skill_names: string[];
  legacy_missing_skill_names: string[];
  legacy_shortlist_rating: ShortlistRating | null;
  should_not_inject_skill_names: string[];
  should_not_load_skill_names: string[];
  comment: string | null;
  comment_source: "user_verbatim" | "assistant_paraphrase" | null;
};

export type SkillUsageFeedbackSummary = Omit<SkillUsageFeedbackRecord, "comment"> & { comment_present: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
}

function relevanceLabels(value: unknown): SkillRelevanceLabel[] | null {
  if (!Array.isArray(value)) return null;
  const labels = new Map<string, SkillRelevanceLabel>();
  for (const item of value) {
    const row = asRecord(item);
    if (!row || typeof row.skill_name !== "string" || !row.skill_name.trim()) return null;
    if (row.relevance !== "relevant" && row.relevance !== "not_relevant" && row.relevance !== "unsure") return null;
    const skill_name = row.skill_name.trim();
    labels.set(skill_name, { skill_name, relevance: row.relevance });
  }
  return [...labels.values()];
}

export function skillUsageFeedbackKey(userId: string | null, sessionId: string, turnId: string): string {
  return JSON.stringify([userId, sessionId, turnId]);
}

export function parseSkillUsageFeedback(value: unknown): SkillUsageFeedbackRecord | null {
  const row = asRecord(value);
  if (!row || ![1, 2, 3, 4, 5].includes(row.schema_version as number) || row.event_type !== "skill_usage_feedback") return null;
  if (typeof row.event_id !== "string" || typeof row.timestamp !== "string") return null;
  if (typeof row.session_id !== "string" || !row.session_id.trim() || typeof row.turn_id !== "string" || !row.turn_id.trim()) return null;
  if (row.user_id !== undefined && row.user_id !== null && typeof row.user_id !== "string") return null;
  if (!Array.isArray(row.should_not_inject_skill_names) || !Array.isArray(row.should_not_load_skill_names)) return null;
  if ((row.schema_version === 4 || row.schema_version === 5) && !Array.isArray(row.user_skill_feedback)) return null;
  if (row.schema_version === 5 && (!Object.hasOwn(row, "injection_decision")
    || (row.injection_decision !== null && row.injection_decision !== "yes" && row.injection_decision !== "no" && row.injection_decision !== "unsure"))) return null;
  const oldSkillNeed = row.legacy_skill_need ?? row.skill_need;
  const legacySkillNeed = oldSkillNeed === "yes" || oldSkillNeed === "no" || oldSkillNeed === "unsure" ? oldSkillNeed : null;
  const rating = row.legacy_shortlist_rating ?? row.shortlist_rating;
  const userSkillFeedback = row.schema_version === 4 || row.schema_version === 5 ? relevanceLabels(row.user_skill_feedback) : [];
  if (userSkillFeedback === null) return null;
  return {
    schema_version: 5,
    event_type: "skill_usage_feedback",
    event_id: row.event_id,
    timestamp: row.timestamp,
    user_id: typeof row.user_id === "string" ? row.user_id : null,
    session_id: row.session_id,
    turn_id: row.turn_id,
    user_skill_feedback: userSkillFeedback,
    injection_decision: row.injection_decision === "yes" || row.injection_decision === "no" || row.injection_decision === "unsure" ? row.injection_decision : null,
    legacy_skill_need: legacySkillNeed,
    legacy_relevant_skill_names: strings(row.legacy_relevant_skill_names ?? row.relevant_skill_names),
    legacy_missing_skill_names: strings(row.legacy_missing_skill_names ?? row.missing_skill_names),
    legacy_shortlist_rating: rating === "helpful" || rating === "not_helpful" ? rating : null,
    should_not_inject_skill_names: strings(row.should_not_inject_skill_names),
    should_not_load_skill_names: strings(row.should_not_load_skill_names),
    comment: typeof row.comment === "string" && row.comment.trim() ? row.comment : null,
    comment_source: row.comment_source === "user_verbatim" || row.comment_source === "assistant_paraphrase" ? row.comment_source : null,
  };
}

export function latestSkillUsageFeedback(rows: unknown[]): Map<string, SkillUsageFeedbackRecord> {
  const latest = new Map<string, SkillUsageFeedbackRecord>();
  for (const row of rows) {
    const record = parseSkillUsageFeedback(row);
    if (record) latest.set(skillUsageFeedbackKey(record.user_id, record.session_id, record.turn_id), record);
  }
  return latest;
}

export function summarizeSkillUsageFeedback(record: SkillUsageFeedbackRecord): SkillUsageFeedbackSummary {
  const { comment, ...summary } = record;
  return { ...summary, comment_present: comment !== null };
}
