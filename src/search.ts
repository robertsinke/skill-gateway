import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { exactLookup, rank, type Document } from "./rank.ts";

export const DEFAULT_ROOT = `${homedir()}/.skills-manager/skills`;
export const GATEWAY_LIBRARY = `${homedir()}/.local/share/skill-gateway/library`;
const CURSOR_ONLY = new Set(["search-skills"]);
export const DEFAULT_LIMIT = 20;

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

export type Skill = {
  document: Document;
  targets: string[];
};

export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return {};
  return parseMapping(lines.slice(1, end));
}

export function loadCatalog(root: string): Skill[] {
  let entries: string[];
  try {
    if (!statSync(root).isDirectory()) throw new SearchError(`library root is missing: ${root}`);
    entries = readdirSync(root);
  } catch (error) {
    if (error instanceof SearchError) throw error;
    throw new SearchError(`library root is missing: ${root}`);
  }
  const skills: Skill[] = [];
  for (const child of entries.sort()) {
    const folder = `${root}/${child}`;
    let folderStat;
    try {
      folderStat = statSync(folder);
    } catch {
      continue;
    }
    if (!folderStat.isDirectory()) continue;
    const skillFile = `${folder}/SKILL.md`;
    let text: string;
    try {
      text = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const meta = parseFrontmatter(text);
    const name = meta.name;
    const skillName = typeof name === "string" && name.trim() ? name.trim() : child;
    if (CURSOR_ONLY.has(skillName) || CURSOR_ONLY.has(child)) continue;
    skills.push({
      document: {
        name: skillName,
        description: descriptionText(meta.description),
        path: realpathSync(folder),
      },
      targets: targets(meta.targets),
    });
  }
  return skills;
}

export function defaultRoots(): string[] {
  const roots: string[] = [];
  if (isDir(GATEWAY_LIBRARY)) roots.push(GATEWAY_LIBRARY);
  if (isDir(DEFAULT_ROOT) && resolve(DEFAULT_ROOT) !== resolve(GATEWAY_LIBRARY)) roots.push(DEFAULT_ROOT);
  return roots.length > 0 ? roots : [DEFAULT_ROOT];
}

export function loadMerged(roots: string[]): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!isDir(root)) continue;
    for (const skill of loadCatalog(root)) {
      if (seen.has(skill.document.name)) continue;
      seen.add(skill.document.name);
      skills.push(skill);
    }
  }
  skills.sort((left, right) => left.document.name.toLowerCase().localeCompare(right.document.name.toLowerCase()));
  return skills;
}

export function search(root: string, query: string, limit = DEFAULT_LIMIT): Result[] {
  const catalog = loadCatalog(root);
  return rank(query, catalog.map((skill) => skill.document), limit).map((hit) => result(hit.document, hit.score));
}

export function lookup(root: string, name: string): Result[] {
  const found = exactLookup(name, loadCatalog(root).map((skill) => skill.document));
  return found ? [result(found, 1)] : [];
}

export function searchRoots(roots: string[], query: string, limit = DEFAULT_LIMIT): Result[] {
  const catalog = loadMerged(roots);
  return rank(query, catalog.map((skill) => skill.document), limit).map((hit) => result(hit.document, hit.score));
}

export function lookupRoots(roots: string[], name: string): Result[] {
  const found = exactLookup(name, loadMerged(roots).map((skill) => skill.document));
  return found ? [result(found, 1)] : [];
}

type Result = { name: string; path: string; description: string; score: number };

function result(document: Document, score: number): Result {
  return { name: document.name, path: document.path, description: document.description, score };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function descriptionText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((part) => String(part).trim()).filter(Boolean).join(" ");
  return "";
}

function targets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function parseMapping(lines: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#") || line[0] === " " || line[0] === "\t") {
      index += 1;
      continue;
    }
    if (!line.includes(":")) {
      index += 1;
      continue;
    }
    const splitAt = line.indexOf(":");
    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim();
    index += 1;
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const block = readBlock(lines, index);
      data[key] = block.value;
      index = block.index;
      continue;
    }
    if (value === "") {
      const list = readList(lines, index);
      data[key] = list.items;
      index = list.index;
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(unquote);
      continue;
    }
    data[key] = unquote(value);
  }
  return data;
}

function readBlock(lines: string[], index: number): { value: string; index: number } {
  const chunks: string[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() && line[0] !== " " && line[0] !== "\t") break;
    chunks.push(line.trim());
    index += 1;
  }
  while (chunks[0] === "") chunks.shift();
  while (chunks.at(-1) === "") chunks.pop();
  return { value: chunks.filter(Boolean).join(" "), index };
}

function readList(lines: string[], index: number): { items: string[]; index: number } {
  const items: string[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line[0] !== " " && line[0] !== "\t") break;
    const stripped = line.trim();
    if (!stripped.startsWith("-")) break;
    items.push(unquote(stripped.slice(1).trim()));
    index += 1;
  }
  return { items, index };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function main(argv: string[]): number {
  let values: { root?: string; limit?: string; exact?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        limit: { type: "string" },
        exact: { type: "string" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const query = positionals.join(" ");
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) {
    console.error("limit must be zero or greater");
    return 1;
  }
  if (values.exact === undefined && !query) {
    console.error("pass a query or --exact");
    return 1;
  }
  try {
    const results =
      values.root === undefined
        ? values.exact !== undefined
          ? lookupRoots(defaultRoots(), values.exact)
          : searchRoots(defaultRoots(), query, limit)
        : values.exact !== undefined
          ? lookup(values.root, values.exact)
          : search(values.root, query, limit);
    console.log(JSON.stringify({ results }));
    return 0;
  } catch (error) {
    if (error instanceof SearchError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (basename(process.argv[1] ?? "") === "search.ts" || basename(process.argv[1] ?? "") === "search.js") {
  process.exit(main(process.argv.slice(2)));
}
