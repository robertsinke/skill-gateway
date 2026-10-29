import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const DEFAULT_USAGE_EVENTS = `${homedir()}/.local/share/skill-gateway/usage-events.jsonl`;

/** One gate decision as recorded by whichever host asked for the selection. */
export type SelectionDecision = {
  timestamp: string;
  platform: string;
  status: string;
  skill: string | null;
  reason: string | null;
  probability: number | null;
  latency_ms: number | null;
  candidates: number;
  session_id: string | null;
  runtime_policy: string | null;
};

export type SelectionReport = {
  decisions: SelectionDecision[];
  counts: { pass: number; reject: number; error: number; no_candidates: number };
  sessions: number;
  truncated: boolean;
};

/**
 * Reads the gate ledger backwards and returns the newest decisions first.
 * Only fields the dashboard renders are exposed: no prompt text or digest.
 */
export function readSelectionEvents(
  path: string = process.env.SKILL_GATEWAY_EVENTS?.trim() || DEFAULT_USAGE_EVENTS,
  limit = 200,
): SelectionReport {
  const counts = { pass: 0, reject: 0, error: 0, no_candidates: 0 };
  const sessions = new Set<string>();
  if (!existsSync(path)) return { decisions: [], counts, sessions: 0, truncated: false };

  const lines = readFileSync(path, "utf8").split("\n");
  const decisions: SelectionDecision[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.event_type !== "gate_decision") continue;
    const decision = toDecision(event);
    if (!decision) continue;
    if (decision.status in counts) counts[decision.status as keyof typeof counts] += 1;
    if (decision.session_id) sessions.add(decision.session_id);
    if (decisions.length < limit) decisions.push(decision);
  }
  return { decisions, counts, sessions: sessions.size, truncated: lines.length > 0 && decisions.length === limit };
}

function toDecision(event: Record<string, unknown>): SelectionDecision | null {
  const status = text(event.gate_status);
  if (!status) return null;
  const names = Array.isArray(event.injected_skill_names) ? event.injected_skill_names.filter((name) => typeof name === "string") : [];
  const candidates = Array.isArray(event.candidate_names) ? event.candidate_names.length : 0;
  return {
    timestamp: text(event.timestamp) ?? "",
    platform: text(event.platform) ?? "unknown",
    status,
    skill: names.length > 0 ? String(names[0]) : null,
    reason: text(event.reason),
    probability: finite(event.probability),
    latency_ms: finite(event.latency_ms),
    candidates,
    session_id: text(event.session_id),
    runtime_policy: text(event.runtime_policy),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
