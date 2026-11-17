import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { relevanceText } from "./relevance-text.ts";
import { selectSkill, type SelectResult } from "./select.ts";

/**
 * Per-turn skill suggestion. The harness keeps its full skill roster.
 * This adds one <skill_relevance> line, which the agent may ignore.
 * A failed lookup adds nothing: saying "nothing applies" is only for a
 * completed decision.
 */

export function suggestionText(name: string | null, reason: string): string {
  return relevanceText(name, reason);
}

export function hookOutput(text: string): string {
  return JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });
}

function promptOf(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  const prompt = record.prompt ?? record.userPrompt;
  return typeof prompt === "string" ? prompt : "";
}

export async function handle(
  payload: unknown,
  select: (prompt: string) => Promise<Pick<SelectResult, "name" | "reason">> = (prompt) =>
    selectSkill({ prompt, platform: "hook", cwd: process.cwd() }, { record: false }),
): Promise<string> {
  const prompt = promptOf(payload);
  if (!prompt.trim()) return hookOutput("");
  try {
    const result = await select(prompt);
    return hookOutput(suggestionText(result.name, result.reason));
  } catch {
    return hookOutput("");
  }
}

async function main(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    payload = null;
  }
  process.stdout.write(`${await handle(payload)}\n`);
}

if (basename(process.argv[1] ?? "") === "suggestion-hook.ts" || basename(process.argv[1] ?? "") === "suggestion-hook.js") {
  main();
}
