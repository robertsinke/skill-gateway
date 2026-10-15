import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { userId, sessionId } from "./query-log.ts";
import { defaultRoots, lookupRoots } from "./search.ts";
import { appendUsageEvent } from "./usage-events.ts";

const NATIVE_SKILL_TOOLS = new Set(["skill", "skills_read_skill", "read_skill", "load_skill", "skills.load", "skill_read"]);
const SKILL_FILE = /(?:^|[\\/])(?:library|skills)[\\/]([A-Za-z0-9_.-]+)[\\/]SKILL\.md$/i;

type JsonRecord = Record<string, unknown>;

export function verifiedSkillNames(toolName: string, rawInput: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  const toolInput = parseInput(rawInput);
  if (!toolName || !toolInput) return [];
  const roots = configuredRoots(env);
  const skillNames = new Set<string>();
  if (isReadTool(toolName)) {
    for (const filePath of inputPaths(toolInput)) {
      const match = SKILL_FILE.exec(filePath);
      if (!match) continue;
      const skill = lookupRoots(roots, match[1] ?? "")[0];
      if (!skill) continue;
      try {
        const actualFile = realpathSync(filePath);
        const expectedFile = realpathSync(join(skill.path, "SKILL.md"));
        if (actualFile === expectedFile) skillNames.add(skill.name);
      } catch {
        // A failed or inaccessible read is not evidence that a skill was loaded.
      }
    }
  }
  if (isNativeSkillTool(toolName)) {
    const name = stringField(toolInput, ["name", "skill", "skill_name"]);
    if (name) {
      const skill = lookupRoots(roots, name)[0];
      if (skill) skillNames.add(skill.name);
    }
  }
  return [...skillNames];
}

export function handleSkillLoad(payload: unknown, env: NodeJS.ProcessEnv = process.env): number {
  if (!isRecord(payload)) return 0;
  const toolName = stringField(payload, ["tool_name", "toolName", "tool"]);
  if (!toolName) return 0;
  const platform = stringField(payload, ["agent", "platform"]).toLowerCase();
  // The Pi extension records reads against the user-message turn; the generic post-tool hook only knows the active run ID.
  if (platform === "pi") return 0;
  const rawInput = payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.arguments;
  const names = verifiedSkillNames(toolName, rawInput, env);
  if (names.length === 0) return 0;
  const turnId = stringField(payload, ["turn_id", "turnId"]);
  const turnIdSource = stringField(payload, ["turn_id_source", "turnIdSource"]) || (turnId ? "host_payload" : "missing");
  const callId = stringField(payload, ["tool_call_id", "toolCallId", "tool_use_id", "toolUseId", "call_id"]);
  const normalizedPlatform = platform || null;
  for (const name of names) {
    appendUsageEvent({
      event_type: "skill_load",
      user_id: userId(payload, env),
      session_id: sessionId(payload),
      turn_id: turnId || null,
      turn_id_source: turnIdSource,
      tool_name: toolName,
      tool_call_id: callId || null,
      platform: normalizedPlatform,
      skill_name: name,
      source: "hooks_use_post_tool_use",
    }, env);
  }
  return names.length;
}

function configuredRoots(env: NodeJS.ProcessEnv): string[] {
  const override = (env.SKILL_GATEWAY_ROOT ?? "").trim();
  return override ? [override] : defaultRoots();
}

function isReadTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return normalized === "read" || normalized === "read_file";
}

function isNativeSkillTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  return NATIVE_SKILL_TOOLS.has(normalized) || normalized.includes("read_skill") || normalized.includes("load_skill");
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().split("__").at(-1)?.trim() ?? "";
}

function inputPaths(input: JsonRecord): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!/(?:path|file)$/i.test(key) || typeof value !== "string") continue;
    paths.push(value);
  }
  return paths;
}

function parseInput(value: unknown): JsonRecord | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringField(value: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function main(): void {
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) handleSkillLoad(JSON.parse(raw));
  } catch {
    // Telemetry must never interfere with the completed tool call.
  }
}

if (basename(process.argv[1] ?? "") === "skill-load-hook.ts" || basename(process.argv[1] ?? "") === "skill-load-hook.js") main();
