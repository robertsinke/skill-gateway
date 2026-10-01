import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const PLACES: [string, string][] = [
  ["Claude", ".claude/skills"],
  ["Codex", ".codex/skills"],
  ["Cursor", ".cursor/skills"],
  ["Agents", ".agents/skills"],
  ["Pi", ".pi/skills"],
  ["OpenCode", ".config/opencode/skills"],
  ["OpenCode", ".opencode/skills"],
  ["Skills Manager", ".skills-manager/skills"],
];

export function libraryDir(home: string = homedir()): string {
  return join(home, ".local", "share", "skill-gateway", "library");
}

export function listPlaces(home: string = homedir()): { place: string; relative: string }[] {
  return PLACES.filter(([, relativePath]) => isDir(join(home, relativePath))).map(([place, relativePath]) => ({
    place,
    relative: relativePath,
  }));
}

export function gather(home: string = homedir()): {
  sources: { place: string; relative: string; found: number; added: number; duplicates: number; removable: number }[];
  imported: string[];
  duplicates: { name: string; kept: string; place: string; path: string }[];
  removable: { name: string; path: string; place: string }[];
} {
  const sources = [];
  const imported: string[] = [];
  const duplicates = [];
  const removable = [];
  for (const place of listPlaces(home)) {
    const report = gatherPlace(place.relative, home);
    sources.push(report.source);
    imported.push(...report.imported);
    duplicates.push(...report.duplicates);
    removable.push(...report.removable);
  }
  return { sources, imported, duplicates, removable };
}

export function gatherPlace(relativePath: string, home: string = homedir()) {
  const place = placeName(relativePath);
  const library = libraryDir(home);
  mkdirSync(library, { recursive: true });
  const origins = readOrigins(library);
  const root = join(home, relativePath);
  let found = 0;
  const added: string[] = [];
  const duplicates: { name: string; kept: string; place: string; path: string }[] = [];
  const removable: { name: string; path: string; place: string }[] = [];
  if (isDir(root)) {
    for (const childName of readdirSync(root).sort()) {
      const child = join(root, childName);
      if (!isSkill(child) || inside(child, library) || childName === "search-skills") continue;
      found += 1;
      const dest = join(library, childName);
      if (existsSync(dest) || childName in origins) {
        duplicates.push({ name: childName, kept: origins[childName] ?? "library", place, path: child });
      } else {
        cpSync(child, dest, { recursive: true });
        origins[childName] = place;
        added.push(childName);
      }
      if (place !== "Skills Manager" && existsSync(join(library, childName, "SKILL.md"))) {
        removable.push({ name: childName, path: child, place });
      }
    }
  }
  writeOrigins(library, origins);
  return {
    source: { place, relative: relativePath, found, added: added.length, duplicates: duplicates.length, removable: removable.length },
    imported: added,
    duplicates,
    removable,
  };
}

export function removeCopies(paths: string[], home: string = homedir()): { removed: string[]; refused: string[] } {
  const library = resolve(libraryDir(home));
  const allowed = PLACES.filter(([, relativePath]) => relativePath !== ".skills-manager/skills").map(([, relativePath]) => resolve(home, relativePath));
  const removed: string[] = [];
  const refused: string[] = [];
  for (const raw of paths) {
    let info;
    try {
      info = lstatSync(raw);
    } catch {
      refused.push(raw);
      continue;
    }
    if (!info.isDirectory() && !info.isSymbolicLink()) {
      refused.push(raw);
      continue;
    }
    if (info.isSymbolicLink()) {
      if (!allowedPath(resolve(raw, ".."), allowed) || !existsSync(join(library, basename(readlinkSync(raw)), "SKILL.md")) && !existsSync(join(library, basename(raw), "SKILL.md"))) {
        refused.push(raw);
        continue;
      }
      unlinkSync(raw);
      removed.push(raw);
      continue;
    }
    const resolved = resolve(raw);
    if (!allowedPath(resolved, allowed) || inside(resolved, library)) {
      refused.push(raw);
      continue;
    }
    if (!existsSync(join(resolved, "SKILL.md")) || !existsSync(join(library, basename(resolved), "SKILL.md"))) {
      refused.push(raw);
      continue;
    }
    rmSync(resolved, { recursive: true });
    removed.push(raw);
    continue;
  }
  return { removed, refused };
}

function placeName(relativePath: string): string {
  const found = PLACES.find(([, candidate]) => candidate === relativePath);
  if (!found) throw new Error(`unknown skill folder: ${relativePath}`);
  return found[0];
}

function isSkill(path: string): boolean {
  return isDir(path) && !basename(path).startsWith(".") && existsSync(join(path, "SKILL.md"));
}

function readOrigins(library: string): Record<string, string> {
  const path = join(library, ".origins.json");
  if (!existsSync(path)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [String(key), String(value)]));
  } catch {
    return {};
  }
}

function writeOrigins(library: string, origins: Record<string, string>): void {
  writeFileSync(join(library, ".origins.json"), JSON.stringify(origins, null, 2), "utf8");
}

function allowedPath(path: string, roots: string[]): boolean {
  return roots.some((root) => isDir(root) && inside(path, root) && resolve(path) !== resolve(root));
}

function inside(path: string, root: string): boolean {
  try {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
