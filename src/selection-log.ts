import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
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
  thread: string | null;
  /** Why a model call failed when one did, e.g. `timeout` or `http_429`. */
  failure: string | null;
  runtime_policy: string | null;
};

export type SelectionReport = {
  decisions: SelectionDecision[];
  counts: { pass: number; reject: number; error: number; no_candidates: number };
  sessions: number;
  /** Older decisions exist beyond the returned window. */
  truncated: boolean;
  /** Gate decisions seen in the window. */
  total: number;
  /**
   * Coverage, not a metric: model calls that failed, by reason, over the
   * decisions returned. A failed call injected nothing, which is not a decline.
   */
  failures: { reason: string; count: number }[];
};

/** The ledger grows without bound, so the dashboard reads only its tail. */
const WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Reads the gate ledger backwards and returns the newest decisions first.
 * Only fields the dashboard renders are exposed: no prompt text or digest.
 * Counts describe the decisions returned, so tiles and table always agree.
 */
/**
 * The thread's newest decisions, newest first, for surfaces that show the latest
 * injection and a short history without loading the whole ledger.
 */
export function readThreadInjections(
  threadId: string,
  limit = 4,
  path: string = process.env.SKILL_GATEWAY_EVENTS?.trim() || DEFAULT_USAGE_EVENTS,
): SelectionDecision[] {
  if (!threadId || limit <= 0) return [];
  return readSelectionEvents(path, 400)
    .decisions.filter((decision) => decision.thread === threadId)
    .slice(0, limit);
}

export function readSelectionEvents(
  path: string = process.env.SKILL_GATEWAY_EVENTS?.trim() || DEFAULT_USAGE_EVENTS,
  limit = 200,
): SelectionReport {
  const counts = { pass: 0, reject: 0, error: 0, no_candidates: 0 };
  const sessions = new Set<string>();
  const empty: SelectionReport = { decisions: [], counts, sessions: 0, truncated: false, total: 0, failures: [] };
  if (!existsSync(path)) return empty;

  const window = readWindow(path);
  if (!window) return empty;

  const decisions: SelectionDecision[] = [];
  let total = 0;
  for (let index = window.lines.length - 1; index >= 0; index -= 1) {
    const line = window.lines[index]?.trim();
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
    total += 1;
    if (decisions.length >= limit) continue;
    decisions.push(decision);
    if (decision.status in counts) counts[decision.status as keyof typeof counts] += 1;
    if (decision.session_id) sessions.add(decision.session_id);
  }
  const byFailure = new Map<string, number>();
  for (const decision of decisions) {
    // Rows written before per-call recording still failed; name what they do say
    // rather than dropping them from the count.
    const failure = decision.failure ?? (decision.status === "error" ? decision.reason ?? "failed" : null);
    if (failure) byFailure.set(failure, (byFailure.get(failure) ?? 0) + 1);
  }
  const failures = [...byFailure.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  return { decisions, counts, sessions: sessions.size, truncated: window.clipped || total > decisions.length, total, failures };
}

/** Reads the last `WINDOW_BYTES` of the ledger, dropping a half line at the seam. */
function readWindow(path: string): { lines: string[]; clipped: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - WINDOW_BYTES);
    const buffer = Buffer.alloc(size - start);
    if (buffer.length === 0) return { lines: [], clipped: false };
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return { lines, clipped: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function toDecision(event: Record<string, unknown>): SelectionDecision | null {
  const status = text(event.gate_status);
  if (!status) return null;
  const names = Array.isArray(event.injected_skill_names) ? event.injected_skill_names.filter((name) => typeof name === "string") : [];
  const candidateCount = typeof event.candidate_count === "number" ? event.candidate_count : null;
  const candidates = candidateCount ?? (Array.isArray(event.candidate_names) ? event.candidate_names.length : 0);
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
    thread: text(event.thread_id),
    failure: firstFailure(event.requests),
    runtime_policy: text(event.runtime_policy),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The model calls a selection can make; both writer paths use these names. */
export const MODEL_PHASES = ["gate", "rerank"] as const;

/**
 * The Jev path called its gate call "ranking" before the two paths shared a
 * vocabulary. Anything else is passed through as written, so a phase that
 * drifts shows up in the view instead of being quietly renamed.
 */
function normalizePhase(phase: string): string {
  return phase === "ranking" ? "gate" : phase;
}

/** The reason the first failed model call gave, when a row records any. */
function firstFailure(requests: unknown): string | null {
  if (!Array.isArray(requests)) return null;
  for (const entry of requests) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.status !== "ok") {
      const reason = text(row.reason) ?? "failed";
      const phase = text(row.phase);
      return phase ? `${normalizePhase(phase)} ${reason}` : reason;
    }
  }
  return null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
