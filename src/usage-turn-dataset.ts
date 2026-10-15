import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promptDigest } from "./usage-events.ts";
import { latestSkillUsageFeedback, type SkillUsageFeedbackRecord } from "./skill-usage-feedback-record.ts";

type Row = Record<string, unknown>;
type GateObservation = {
  status: string | null;
  model: string | null;
  probability: number | null;
  threshold: number | null;
  candidate_names: string[];
  candidate_rankings: { rank: number | null; name: string; search_score: number | null }[];
  injected_skill_names: string[];
  request_attempted: boolean | null;
  state_characters: number | null;
  request_body_characters: number | null;
  request_body_bytes: number | null;
  input_tokens: number | null;
  estimated_input_tokens: number | null;
  output_tokens: number | null;
  input_tokens_source: string | null;
  jev_list_cost_usd: number | null;
  cost_basis: string | null;
  cost_rate_usd_per_million_input_tokens: number | null;
  cost_rate_source: string | null;
  latency_ms: number | null;
  reason: string | null;
};

type TurnRow = {
  schema_version: 2;
  user_id: string | null;
  session_id: string;
  turn_id: string;
  turn_id_sources: string[];
  platform: string | null;
  query: string | null;
  query_timestamp: string | null;
  query_match_status: "matched_hash" | "turn_id_only" | "hash_mismatch" | "ambiguous" | "missing_query";
  gate_decisions: GateObservation[];
  injected_skill_names: string[];
  loaded_skill_names: string[];
  loaded_injected_skill_names: string[];
  loaded_not_injected_skill_names: string[];
  verified_load_count: number;
  observed_at: string | null;
  feedback: SkillUsageFeedbackRecord | null;
};

function asRecord(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
}

function completeKey(row: Row): string | null {
  const sessionId = text(row.session_id);
  const turnId = text(row.turn_id);
  if (!sessionId || !turnId) return null;
  return JSON.stringify([text(row.user_id), sessionId, turnId]);
}

function eventTime(row: Row): string | null {
  return text(row.timestamp) ?? text(row.date);
}

function parseGate(row: Row): GateObservation {
  const rankings = Array.isArray(row.candidate_rankings) ? row.candidate_rankings.flatMap((value) => {
    const item = asRecord(value);
    const name = text(item?.name);
    if (!item || !name) return [];
    return [{ rank: number(item.rank), name, search_score: number(item.search_score) }];
  }) : [];
  return {
    status: text(row.gate_status),
    model: text(row.gate_model),
    probability: number(row.probability),
    threshold: number(row.threshold),
    candidate_names: strings(row.candidate_names),
    candidate_rankings: rankings,
    injected_skill_names: strings(row.injected_skill_names),
    request_attempted: typeof row.request_attempted === "boolean" ? row.request_attempted : null,
    state_characters: number(row.state_characters),
    request_body_characters: number(row.request_body_characters),
    request_body_bytes: number(row.request_body_bytes),
    input_tokens: number(row.input_tokens),
    estimated_input_tokens: number(row.estimated_input_tokens),
    output_tokens: number(row.output_tokens),
    input_tokens_source: text(row.input_tokens_source),
    jev_list_cost_usd: number(row.jev_list_cost_usd),
    cost_basis: text(row.cost_basis),
    cost_rate_usd_per_million_input_tokens: number(row.cost_rate_usd_per_million_input_tokens),
    cost_rate_source: text(row.cost_rate_source),
    latency_ms: number(row.latency_ms),
    reason: text(row.reason),
  };
}

export function buildUsageTurnDataset(events: unknown[], queryRows: unknown[], feedbackRows: unknown[] = []): {
  rows: TurnRow[];
  metadata: Record<string, unknown>;
} {
  const groups = new Map<string, { gates: Row[]; loads: Row[]; queries: Row[] }>();
  const feedback = latestSkillUsageFeedback(feedbackRows);
  const unlinked = { gate_decisions: 0, skill_loads: 0, queries: 0, feedback_records: 0 };
  const groupFor = (row: Row) => {
    const key = completeKey(row);
    if (!key) return null;
    let group = groups.get(key);
    if (!group) {
      group = { gates: [], loads: [], queries: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const value of events) {
    const row = asRecord(value);
    if (!row) continue;
    const eventType = text(row.event_type);
    if (eventType !== "gate_decision" && eventType !== "skill_load") continue;
    const group = groupFor(row);
    if (!group) {
      if (eventType === "gate_decision") unlinked.gate_decisions += 1;
      else unlinked.skill_loads += 1;
      continue;
    }
    if (eventType === "gate_decision") group.gates.push(row);
    else group.loads.push(row);
  }

  for (const value of queryRows) {
    const row = asRecord(value);
    if (!row || typeof row.query !== "string") continue;
    const group = groupFor(row);
    if (!group) {
      unlinked.queries += 1;
      continue;
    }
    group.queries.push(row);
  }

  unlinked.feedback_records = [...feedback.keys()].filter((key) => !groups.has(key)).length;
  const rows: TurnRow[] = [...groups.entries()].map(([key, group]) => {
    const gates = group.gates.sort((a, b) => (eventTime(a) ?? "").localeCompare(eventTime(b) ?? ""));
    const loads = group.loads.sort((a, b) => (eventTime(a) ?? "").localeCompare(eventTime(b) ?? ""));
    const queries = group.queries;
    const promptHashes = new Set(gates.map((gate) => text(gate.prompt_sha256)).filter((hash): hash is string => Boolean(hash)));
    const matchingQueries = promptHashes.size
      ? queries.filter((query) => promptHashes.has(promptDigest(String(query.query).trim())))
      : queries;
    const uniqueQueries = [...new Map(matchingQueries.map((query) => [String(query.query), query])).values()];
    const selectedQuery = uniqueQueries.length === 1 ? uniqueQueries[0] : null;
    const queryMatchStatus: TurnRow["query_match_status"] = selectedQuery
      ? promptHashes.size ? "matched_hash" : "turn_id_only"
      : queries.length === 0 ? "missing_query"
        : promptHashes.size && matchingQueries.length === 0 ? "hash_mismatch" : "ambiguous";
    const injected = [...new Set(gates.flatMap((gate) => strings(gate.injected_skill_names)))];
    const loaded = [...new Set(loads.map((load) => text(load.skill_name)).filter((name): name is string => Boolean(name)))];
    const injectedSet = new Set(injected);
    const first = [...gates, ...loads, ...queries].sort((a, b) => (eventTime(a) ?? "").localeCompare(eventTime(b) ?? ""))[0];
    const last = [...gates, ...loads, ...queries].sort((a, b) => (eventTime(b) ?? "").localeCompare(eventTime(a) ?? ""))[0];
    const timestamps = [...gates, ...loads].map(eventTime).filter((item): item is string => Boolean(item));
    const identitySourceRows = [...gates, ...loads];
    const sources = [...new Set(identitySourceRows.map((row) => text(row.turn_id_source)).filter((item): item is string => Boolean(item)))];
    return {
      schema_version: 2,
      user_id: text(first?.user_id),
      session_id: String(first?.session_id ?? ""),
      turn_id: String(first?.turn_id ?? ""),
      turn_id_sources: sources,
      platform: text(first?.platform),
      query: selectedQuery ? String(selectedQuery.query) : null,
      query_timestamp: selectedQuery ? eventTime(selectedQuery) : null,
      query_match_status: queryMatchStatus,
      gate_decisions: gates.map(parseGate),
      injected_skill_names: injected,
      loaded_skill_names: loaded,
      loaded_injected_skill_names: loaded.filter((name) => injectedSet.has(name)),
      loaded_not_injected_skill_names: loaded.filter((name) => !injectedSet.has(name)),
      verified_load_count: loads.length,
      observed_at: timestamps[0] ?? eventTime(last ?? {}) ?? eventTime(first ?? {}) ?? null,
      feedback: feedback.get(key) ?? null,
    };
  });
  rows.sort((a, b) => `${a.session_id}\u0000${a.turn_id}`.localeCompare(`${b.session_id}\u0000${b.turn_id}`));
  return {
    rows,
    metadata: {
      schema_version: 2,
      generated_at: new Date().toISOString(),
      turn_count: rows.length,
      turns_with_gate_decision: rows.filter((row) => row.gate_decisions.length > 0).length,
      turns_with_verified_load: rows.filter((row) => row.verified_load_count > 0).length,
      turns_with_explicit_feedback: rows.filter((row) => row.feedback !== null).length,
      turns_with_shortlist_rating: rows.filter((row) => row.feedback?.shortlist_rating !== null && row.feedback?.shortlist_rating !== undefined).length,
      unlinked_event_counts: unlinked,
      query_match_counts: Object.fromEntries(["matched_hash", "turn_id_only", "hash_mismatch", "ambiguous", "missing_query"].map((status) => [status, rows.filter((row) => row.query_match_status === status).length])),
      passive_reactions_and_followups_included: false,
      explicit_user_feedback_included: true,
    },
  };
}

export function readJsonl(path: string): Row[] {
  if (!path || path === "-" || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = asRecord(JSON.parse(line));
      return row ? [row] : [];
    } catch {
      return [];
    }
  });
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function writeUsageTurnDataset(rows: TurnRow[], metadata: Record<string, unknown>, outputPath: string): void {
  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n");
  atomicWrite(outputPath, jsonl ? `${jsonl}\n` : "");
  atomicWrite(`${outputPath}.meta.json`, `${JSON.stringify(metadata, null, 2)}\n`);
}
