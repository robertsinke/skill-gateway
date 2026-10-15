export type ShortlistRating = "helpful" | "not_helpful";

export type SkillUsageFeedbackRecord = {
  schema_version: 2;
  event_type: "skill_usage_feedback";
  event_id: string;
  timestamp: string;
  user_id: string | null;
  session_id: string;
  turn_id: string;
  shortlist_rating: ShortlistRating | null;
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
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))] : [];
}

export function skillUsageFeedbackKey(userId: string | null, sessionId: string, turnId: string): string {
  return JSON.stringify([userId, sessionId, turnId]);
}

export function parseSkillUsageFeedback(value: unknown): SkillUsageFeedbackRecord | null {
  const row = asRecord(value);
  if (!row || (row.schema_version !== 1 && row.schema_version !== 2) || row.event_type !== "skill_usage_feedback") return null;
  if (typeof row.event_id !== "string" || typeof row.timestamp !== "string") return null;
  if (typeof row.session_id !== "string" || !row.session_id.trim() || typeof row.turn_id !== "string" || !row.turn_id.trim()) return null;
  if (!Array.isArray(row.should_not_inject_skill_names) || !Array.isArray(row.should_not_load_skill_names)) return null;
  const userId = typeof row.user_id === "string" ? row.user_id : null;
  return {
    schema_version: 2,
    event_type: "skill_usage_feedback",
    event_id: row.event_id,
    timestamp: row.timestamp,
    user_id: userId,
    session_id: row.session_id,
    turn_id: row.turn_id,
    shortlist_rating: row.shortlist_rating === "helpful" || row.shortlist_rating === "not_helpful" ? row.shortlist_rating : null,
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
