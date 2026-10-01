import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { rank, type Document } from "./rank.ts";
import { DEFAULT_ROOT, SearchError, loadCatalog, type Skill } from "./search.ts";

export const GREEN_RANK = 10;

type Failure = { target: string; rank: number | null; above: string[] };
type TargetRow = { target: string; ok: boolean; rank: number | null; above: string[] };

export function check(root: string): { green: string[]; red: { name: string; path: string; failures: Failure[] }[]; skipped: string[] } {
  const catalog = loadCatalog(root);
  const documents = catalog.map((skill) => skill.document);
  const green: string[] = [];
  const red: { name: string; path: string; failures: Failure[] }[] = [];
  const skipped: string[] = [];
  for (const skill of catalog) {
    if (skill.targets.length !== 3) {
      skipped.push(skill.document.name);
      continue;
    }
    const failures: Failure[] = [];
    for (const target of skill.targets) {
      const row = targetRow(target, documents, skill.document.path);
      if (row.ok) continue;
      failures.push({ target: row.target, rank: row.rank, above: row.above });
    }
    if (failures.length > 0) red.push({ name: skill.document.name, path: skill.document.path, failures });
    else green.push(skill.document.name);
  }
  green.sort();
  skipped.sort();
  red.sort((left, right) => left.name.localeCompare(right.name));
  return { green, red, skipped };
}

export function preview(root: string, name: string, description: string, targets: string[] | null = null, catalog: Skill[] | null = null): {
  name: string;
  description: string;
  targets: string[];
  ready: boolean;
  green: boolean;
  rows: TargetRow[];
} {
  const skills = catalog ?? loadCatalog(root);
  const match = skills.find((skill) => skill.document.name === name);
  if (!match) throw new SearchError(`skill not found: ${name}`);
  const chosen = targets === null ? [...match.targets] : targets.map((item) => item.trim()).filter(Boolean);
  const documents = skills.map((skill) =>
    skill.document.path === match.document.path ? { name: skill.document.name, description, path: skill.document.path } : skill.document,
  );
  const rows = chosen.map((target) => targetRow(target, documents, match.document.path));
  const ready = chosen.length === 3;
  return {
    name: match.document.name,
    description,
    targets: chosen,
    ready,
    green: ready && rows.every((row) => row.ok),
    rows,
  };
}

export function saveTargets(root: string, name: string, targets: string[], catalog: Skill[] | null = null): string[] {
  const cleaned = targets.map((item) => item.trim());
  if (cleaned.length !== 3 || cleaned.some((item) => !item)) throw new SearchError("save exactly three messages");
  const skills = catalog ?? loadCatalog(root);
  const match = skills.find((skill) => skill.document.name === name);
  if (!match) throw new SearchError(`skill not found: ${name}`);
  const path = join(match.document.path, "SKILL.md");
  writeFileSync(path, replaceTargets(readFileSync(path, "utf8"), cleaned), "utf8");
  return cleaned;
}

function targetRow(target: string, documents: Document[], path: string): TargetRow {
  const hits = rank(target, documents, Math.max(documents.length, 1));
  const index = hits.findIndex((hit) => hit.document.path === path);
  const found = index >= 0;
  const above = (found ? hits.slice(0, index) : hits.slice(0, GREEN_RANK)).map((hit) => hit.document.name);
  return { target, ok: found && index < GREEN_RANK, rank: found ? index + 1 : null, above };
}

function replaceTargets(text: string, targets: string[]): string {
  if (!text.startsWith("---\n")) throw new SearchError("skill file has no frontmatter");
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new SearchError("skill file has no frontmatter");
  const front = text.slice(4, end).split("\n");
  const kept: string[] = [];
  let index = 0;
  while (index < front.length) {
    const line = front[index] ?? "";
    if (line.startsWith("targets:")) {
      index += 1;
      while (index < front.length && isTargetItem(front[index] ?? "")) index += 1;
      continue;
    }
    kept.push(line);
    index += 1;
  }
  const block = ["targets:", ...targets.map((item) => `  - ${yamlString(item)}`)];
  const rebuilt = [...kept, ...block].join("\n").replace(/^\n+|\n+$/g, "");
  return `---\n${rebuilt}\n${text.slice(end + 1)}`;
}

function isTargetItem(line: string): boolean {
  if (!line.trim()) return true;
  return (line[0] === " " || line[0] === "\t") && line.trimStart().startsWith("-");
}

function yamlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function main(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { root: { type: "string", default: DEFAULT_ROOT } } });
  try {
    console.log(JSON.stringify(check(values.root ?? DEFAULT_ROOT)));
    return 0;
  } catch (error) {
    if (error instanceof SearchError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (basename(process.argv[1] ?? "") === "check.ts" || basename(process.argv[1] ?? "") === "check.js") {
  process.exit(main(process.argv.slice(2)));
}
