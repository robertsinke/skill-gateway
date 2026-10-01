import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const DEFAULT_LOG = `${homedir()}/.local/share/skill-gateway/queries.jsonl`;

export type QueryRow = Record<string, unknown>;

export function logPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = (env.SKILL_GATEWAY_LOG ?? "").trim();
  if (override === "-") return null;
  if (override) return override;
  return DEFAULT_LOG;
}

export function userId(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ["user_id", "userId"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const fromGateway = (env.SKILL_GATEWAY_USER ?? "").trim();
  if (fromGateway) return fromGateway;
  return (env.USER ?? "").trim() || "local";
}

export function sessionId(payload: Record<string, unknown>): string {
  for (const key of ["session_id", "sessionId"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function record(payload: Record<string, unknown>, query: string, skills: string[], env: NodeJS.ProcessEnv = process.env): void {
  const path = logPath(env);
  if (path === null) return;
  const ranks = skills.map((name, index) => ({ rank: index + 1, name }));
  const entry = {
    date: new Date().toISOString(),
    user_id: userId(payload, env),
    session_id: sessionId(payload),
    query,
    ranks,
    skills,
    selected: null,
    completed: null,
    followup: null,
    reaction: null,
    helped: null,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function noteFollowup(session: string, text: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = logPath(env);
  const cleaned = text.trim();
  if (path === null || !session || !cleaned) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    let item: QueryRow;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      item = parsed as QueryRow;
    } catch {
      continue;
    }
    if (item.session_id !== session || item.followup !== null) continue;
    item.followup = cleaned;
    item.reaction = reactionTo(cleaned);
    lines[index] = JSON.stringify(item);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return;
  }
}

export function reactionTo(text: string): "negative" | "positive" | null {
  const folded = text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!folded || folded.length > 80) return null;
  if (["wrong", "didn't", "did not", "not what", "try again", "stop"].some((phrase) => folded.includes(phrase))) return "negative";
  if (["thank", "perfect", "great", "looks good", "that works", "nice"].some((phrase) => folded.includes(phrase))) return "positive";
  return null;
}

export function suggestMessages(rows: QueryRow[], skillName: string, limit = 3): string[] {
  const weight = new Map<string, number>();
  for (const row of rows) {
    const skills = row.skills;
    const query = row.query;
    if (!Array.isArray(skills) || typeof query !== "string") continue;
    const text = query.trim();
    if (!text || !skills.includes(skillName)) continue;
    const rankIndex = skills.indexOf(skillName);
    weight.set(text, (weight.get(text) ?? 0) + Math.max(1, 20 - rankIndex));
  }
  return [...weight.keys()].sort((left, right) => (weight.get(right) ?? 0) - (weight.get(left) ?? 0) || left.localeCompare(right)).slice(0, limit);
}

export function readRecent(path: string, limit = 200): QueryRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: QueryRow[] = [];
  for (const line of raw.split("\n").slice(-limit)) {
    if (!line.trim()) continue;
    try {
      const item: unknown = JSON.parse(line);
      if (item && typeof item === "object" && !Array.isArray(item)) rows.push(item as QueryRow);
    } catch {
      continue;
    }
  }
  rows.reverse();
  return rows;
}
