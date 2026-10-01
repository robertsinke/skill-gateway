import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DB = `${homedir()}/.skills-manager/skills-manager.db`;
const GITHUB = /github\.com[:/]([^/]+)\/([^/#.\s]+)/;

export function loadIndex(dbPath: string | null = null): Record<string, { source: string; owner: string }> {
  const path = dbPath ?? DEFAULT_DB;
  if (!existsSync(path)) return {};
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = connection.prepare("SELECT name, source_type, source_ref, source_ref_resolved FROM skills").all() as {
      name: string;
      source_type: unknown;
      source_ref: unknown;
      source_ref_resolved: unknown;
    }[];
    const index: Record<string, { source: string; owner: string }> = {};
    for (const row of rows) index[String(row.name)] = provenance(row.source_type, row.source_ref, row.source_ref_resolved);
    return index;
  } finally {
    connection.close();
  }
}

export function provenance(sourceType: unknown, sourceRef: unknown, sourceRefResolved: unknown): { source: string; owner: string } {
  const kind = String(sourceType || "");
  const ref = String(sourceRef || "");
  const resolved = String(sourceRefResolved || "");
  if (kind === "skillssh") return { source: "skills.sh", owner: ref.split("/", 1)[0] ?? "" };
  if (kind === "git") {
    const match = GITHUB.exec(resolved || ref);
    return match ? { source: "GitHub", owner: `${match[1]}/${match[2]}` } : { source: "GitHub", owner: "" };
  }
  if (kind === "local") return { source: "local", owner: "" };
  if (kind === "import") return { source: "imported", owner: "" };
  return { source: kind, owner: "" };
}
