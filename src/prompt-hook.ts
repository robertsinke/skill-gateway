import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { noteFollowup, record, sessionId } from "./query-log.ts";
import { search, searchRoots, defaultRoots, SearchError } from "./search.ts";

const LIMIT = 20;

const ANOTHER_SEARCH = `To search this library again during this same user message, run:
node ~/.local/share/skill-gateway/dist/search.js "<query>" --limit 10
When the user names a skill, run:
node ~/.local/share/skill-gateway/dist/search.js --exact "<name>"
Pass the query in the user's words. An empty result means load no library skill.
If this conversation already loaded a listed skill, reuse it instead of reading it again.
Read a skill file only when the task matches and it has not been loaded earlier in this conversation.`;

type Hit = { name?: unknown; path?: unknown; description?: unknown };

function empty(): void {
  console.log(
    JSON.stringify({
      systemMessage: "",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "",
      },
    }),
  );
}

export function formatShortlist(results: Hit[]): string {
  const lines = ["Skill library shortlist. Load a library skill only from this list."];
  results.forEach((hit, index) => {
    const name = String(hit.name ?? "").trim();
    const path = String(hit.path ?? "").trim();
    const description = String(hit.description ?? "").trim();
    if (!name || !path) return;
    lines.push(`- ${index + 1}. ${name} — ${path} — ${description}`);
  });
  const body = lines.length === 1 ? ["Skill library shortlist is empty. Load no library skill from this search."] : lines;
  return `${body.join("\n")}\n\n${ANOTHER_SEARCH}`;
}

function isPi(payload: Record<string, unknown>): boolean {
  if (payload.agent === "pi") return true;
  for (const key of ["transcript_path", "transcriptPath"]) {
    const value = payload[key];
    if (typeof value === "string" && value.replaceAll("\\", "/").includes("/.pi/")) return true;
  }
  return false;
}

function searchPrompt(prompt: string, env: NodeJS.ProcessEnv): Hit[] {
  const override = (env.SKILL_GATEWAY_ROOT ?? "").trim();
  if (override) return search(override, prompt, LIMIT);
  return searchRoots(defaultRoots(), prompt, LIMIT);
}

export function handle(payload: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return emptyJson();
  const recordPayload = payload as Record<string, unknown>;
  const prompt = recordPayload.prompt !== undefined && recordPayload.prompt !== null ? recordPayload.prompt : recordPayload.userPrompt;
  if (typeof prompt !== "string" || !prompt.trim()) return emptyJson();
  let results: Hit[];
  try {
    results = searchPrompt(prompt, env);
  } catch (error) {
    if (error instanceof SearchError) return emptyJson();
    throw error;
  }
  const text = formatShortlist(results);
  const promptText = prompt.trim();
  try {
    noteFollowup(sessionId(recordPayload), promptText, env);
    const names = results.map((hit) => String(hit.name ?? "").trim()).filter(Boolean);
    record(recordPayload, promptText, names, env);
  } catch {
    // The log is best-effort. The shortlist still returns.
  }
  let systemMessage: string;
  if (isPi(recordPayload)) systemMessage = "";
  else if (recordPayload.turn_id) systemMessage = text;
  else systemMessage = `${promptText}\n\n${text}`;
  return JSON.stringify({
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });
}

function emptyJson(): string {
  return JSON.stringify({
    systemMessage: "",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "",
    },
  });
}

function main(): void {
  try {
    const raw = readFileSync(0, "utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      empty();
      return;
    }
    console.log(handle(payload));
  } catch {
    empty();
  }
}

if (basename(process.argv[1] ?? "") === "prompt-hook.ts" || basename(process.argv[1] ?? "") === "prompt-hook.js") {
  main();
}
