import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultRoots, loadCatalog, loadMerged, type Skill } from "./search.ts";

const MANIFEST = ".skill-gateway-pointers.json";
const MARKER = ".skill-gateway-pointer";
const MARKER_CONTENT = "skill-gateway metadata pointer v1\n";
const MAX_CODEX_NAME_LENGTH = 64;

type PointerEntry = { directory: string; sha256: string };
type PointerManifest = { version: 1; managed: PointerEntry[] };

/** Sync metadata-only skill pointers into a Codex skill root. No library bodies are copied. */
export function syncCodexSkillPointers(outputRoot: string, skills = loadLibrarySkills()): string[] {
  const output = resolve(outputRoot);
  mkdirSync(output, { recursive: true });
  if (!lstatSync(output).isDirectory()) throw new Error(`Codex skill root is not a directory: ${output}`);

  const lockPath = join(output, ".skill-gateway-pointers.lock");
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch {
    throw new Error(`Codex pointer sync is already running or left a stale lock at ${lockPath}`);
  }

  try {
    const previous = readManifest(join(output, MANIFEST));
    const previousByDirectory = new Map(previous.managed.map((entry) => [entry.directory, entry]));
    const next = skills.map((skill) => {
      const content = pointerContent(skill);
      return { directory: directoryName(skill.document.name), content, sha256: digest(content) };
    });
    const nextNames = new Set(next.map(({ directory }) => directory));
    if (nextNames.size !== next.length) throw new Error("library contains colliding skill names");

    for (const entry of next) {
      writePointer(output, entry.directory, entry.content, previousByDirectory.get(entry.directory)?.sha256);
    }

    const retained: PointerEntry[] = [];
    for (const oldEntry of previous.managed) {
      if (nextNames.has(oldEntry.directory)) continue;
      const oldPath = join(output, oldEntry.directory);
      if (!existsSync(oldPath)) continue;
      const stat = lstatSync(oldPath);
      const contents = stat.isDirectory() && !stat.isSymbolicLink() ? readdirSync(oldPath).sort() : [];
      const skillPath = join(oldPath, "SKILL.md");
      const isUnmodifiedPointer =
        stat.isDirectory() && !stat.isSymbolicLink() &&
        contents.length === 2 && contents.includes(MARKER) && contents.includes("SKILL.md") &&
        readMarker(oldPath) === MARKER_CONTENT && existsSync(skillPath) &&
        digest(readFileSync(skillPath, "utf8")) === oldEntry.sha256;
      if (isUnmodifiedPointer) rmSync(oldPath, { recursive: true, force: false });
      else retained.push(oldEntry);
    }

    const managed = [...next.map(({ directory, sha256 }) => ({ directory, sha256 })), ...retained];
    writeAtomic(join(output, MANIFEST), `${JSON.stringify({ version: 1, managed }, null, 2)}\n`);
    return next.map(({ directory }) => join(output, directory, "SKILL.md"));
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

export function pointerContent(skill: Skill): string {
  const name = skill.document.name;
  const codexName = name.length <= MAX_CODEX_NAME_LENGTH ? name : `gateway-${directoryName(name).slice("skill-".length, 32)}`;
  const nameLiteral = JSON.stringify(name).replace(/`/g, "\\u0060");
  return [
    "---",
    `name: ${JSON.stringify(codexName)}`,
    `description: ${JSON.stringify(skill.document.description || `Read the private library skill ${name}`)}`,
    "---",
    "",
    "This is a metadata-only pointer to a private Skill Gateway library skill; it does not contain the skill instructions.",
    `When selected, call the MCP tool skills_read_skill with the exact name ${nameLiteral}. Follow the returned skill instructions.`,
    "Do not search for a local copy or construct a filesystem path. If the gateway tool is unavailable or returns an error, report that clearly and stop.",
    "",
  ].join("\n");
}

function loadLibrarySkills(): Skill[] {
  const override = (process.env.SKILL_GATEWAY_ROOT ?? "").trim();
  if (override) return loadCatalog(override);
  const roots = defaultRoots();
  const catalog = loadMerged(roots);
  if (catalog.length === 0) loadCatalog(roots[0]!);
  return catalog;
}

function directoryName(name: string): string {
  return `skill-${digest(name).slice(0, 16)}`;
}

function isSafeDirectoryName(name: string): boolean {
  return /^skill-[a-f0-9]{16}$/.test(name) && basename(name) === name;
}

function writePointer(root: string, directory: string, content: string, previousHash?: string): void {
  if (!isSafeDirectoryName(directory)) throw new Error(`unsafe generated skill directory: ${directory}`);
  const path = join(root, directory);
  const skillPath = join(path, "SKILL.md");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readMarker(path) !== MARKER_CONTENT) {
      throw new Error(`refusing to overwrite non-generated Codex skill: ${path}`);
    }
    if (existsSync(skillPath)) {
      const current = readFileSync(skillPath, "utf8");
      if (current !== content && (!previousHash || digest(current) !== previousHash)) {
        throw new Error(`refusing to overwrite a modified Codex skill pointer: ${skillPath}`);
      }
    }
  } else {
    mkdirSync(path);
  }
  writeFileSync(join(path, MARKER), MARKER_CONTENT, "utf8");
  writeAtomic(skillPath, content);
}

function readManifest(path: string): PointerManifest {
  if (!existsSync(path)) return { version: 1, managed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`refusing to replace invalid pointer manifest: ${path}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`refusing to replace invalid pointer manifest: ${path}`);
  const value = parsed as { version?: unknown; managed?: unknown };
  if (value.version !== 1 || !Array.isArray(value.managed)) throw new Error(`unsupported pointer manifest: ${path}`);
  const managed: PointerEntry[] = [];
  for (const entry of value.managed) {
    if (
      !entry || typeof entry !== "object" ||
      typeof entry.directory !== "string" || !isSafeDirectoryName(entry.directory) ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) throw new Error(`refusing to replace invalid pointer manifest: ${path}`);
    managed.push({ directory: entry.directory, sha256: entry.sha256 });
  }
  return { version: 1, managed };
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function readMarker(directory: string): string | undefined {
  try {
    const path = join(directory, MARKER);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
