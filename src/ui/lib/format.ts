import type { SearchRow, Skill } from "./types";

export function phrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function sourceLine(skill: { source: string; owner: string }): string {
  if (skill.source && skill.owner) return `${skill.source} · ${skill.owner}`;
  return skill.source || skill.owner;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asSkill(value: unknown): Skill | null {
  const row = record(value);
  if (!row || typeof row.name !== "string") return null;
  const targets = Array.isArray(row.targets) ? row.targets.filter((item): item is string => typeof item === "string") : [];
  return {
    name: row.name,
    description: text(row.description),
    targets,
    opensToolServer: row.opensToolServer === true,
    source: text(row.source),
    owner: text(row.owner),
    location: text(row.location),
    added: text(row.added),
    addedAt: number(row.addedAt),
    uses: number(row.uses),
    status: text(row.status),
  };
}

export function asSearch(value: unknown): SearchRow | null {
  const row = record(value);
  if (!row) return null;
  const skills = Array.isArray(row.skills) ? row.skills.filter((item): item is string => typeof item === "string") : [];
  const ranks = Array.isArray(row.ranks)
    ? row.ranks.flatMap((item) => {
        const hit = record(item);
        if (!hit || typeof hit.name !== "string") return [];
        return [{ rank: number(hit.rank), name: hit.name }];
      })
    : [];
  return {
    date: text(row.date),
    user_id: text(row.user_id),
    session_id: text(row.session_id),
    query: text(row.query),
    skills,
    ranks,
    followup: typeof row.followup === "string" ? row.followup : null,
    reaction: typeof row.reaction === "string" ? row.reaction : null,
  };
}
