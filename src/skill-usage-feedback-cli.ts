import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  searchSkillUsageTurns,
  updateSkillUsageFeedback,
  type SearchSkillUsageTurnsInput,
  type UpdateSkillUsageFeedbackInput,
} from "./skill-usage-feedback.ts";

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object.");
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown input field(s): ${unknown.join(", ")}`);
}

function optionalString(input: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${key} must be a string of at most ${maxLength} characters.`);
  return value;
}

function parseSearch(input: Record<string, unknown>): SearchSkillUsageTurnsInput {
  rejectUnknownKeys(input, ["query", "user_id", "session_id", "turn_id", "limit"]);
  const result: SearchSkillUsageTurnsInput = {};
  const query = optionalString(input, "query", 4000);
  const sessionId = optionalString(input, "session_id", 200);
  const turnId = optionalString(input, "turn_id", 200);
  if (query !== undefined) result.query = query;
  if (sessionId !== undefined) result.session_id = sessionId;
  if (turnId !== undefined) result.turn_id = turnId;
  if (input.user_id !== undefined) {
    if (input.user_id !== null && (typeof input.user_id !== "string" || input.user_id.length > 200)) throw new Error("user_id must be null or a string of at most 200 characters.");
    result.user_id = input.user_id as string | null;
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new Error("limit must be an integer from 1 to 20.");
    result.limit = input.limit;
  }
  return result;
}

function parseUpdate(input: Record<string, unknown>): UpdateSkillUsageFeedbackInput {
  rejectUnknownKeys(input, ["user_id", "session_id", "turn_id", "shortlist_rating", "should_not_inject_skill_names", "should_not_load_skill_names", "comment", "comment_source"]);
  if (input.user_id !== null && (typeof input.user_id !== "string" || input.user_id.length > 200)) throw new Error("user_id must be null or a string of at most 200 characters.");
  const sessionId = optionalString(input, "session_id", 200);
  const turnId = optionalString(input, "turn_id", 200);
  if (!sessionId?.trim() || !turnId?.trim()) throw new Error("session_id and turn_id are required.");
  const skillNames = (key: string): string[] | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || item.length > 200)) {
      throw new Error(`${key} must be an array of at most 20 skill names, each at most 200 characters.`);
    }
    return value as string[];
  };
  const shouldNotInject = skillNames("should_not_inject_skill_names");
  const shouldNotLoad = skillNames("should_not_load_skill_names");
  const shortlistRating = input.shortlist_rating;
  if (shortlistRating !== undefined && shortlistRating !== null && shortlistRating !== "helpful" && shortlistRating !== "not_helpful") {
    throw new Error("shortlist_rating must be helpful, not_helpful, or null.");
  }
  const comment = optionalString(input, "comment", 2000);
  const commentSource = input.comment_source;
  if (commentSource !== undefined && commentSource !== "user_verbatim" && commentSource !== "assistant_paraphrase") {
    throw new Error("comment_source must be user_verbatim or assistant_paraphrase.");
  }
  return {
    user_id: input.user_id as string | null,
    session_id: sessionId,
    turn_id: turnId,
    ...(shortlistRating !== undefined ? { shortlist_rating: shortlistRating as "helpful" | "not_helpful" | null } : {}),
    ...(shouldNotInject !== undefined ? { should_not_inject_skill_names: shouldNotInject } : {}),
    ...(shouldNotLoad !== undefined ? { should_not_load_skill_names: shouldNotLoad } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(commentSource !== undefined ? { comment_source: commentSource } : {}),
  };
}

export function runSkillUsageFeedbackCli(args: string[]): unknown {
  const [operation, inputArgument, ...extra] = args;
  if (extra.length || !operation || (operation !== "search" && operation !== "update")) {
    throw new Error("Usage: skill-usage-feedback-cli <search|update> '<JSON object>' (or pass - to read JSON from stdin)");
  }
  const rawInput = inputArgument === "-" ? readFileSync(0, "utf8") : inputArgument ?? "{}";
  const input = objectInput(JSON.parse(rawInput));
  return operation === "search"
    ? searchSkillUsageTurns(parseSearch(input))
    : updateSkillUsageFeedback(parseUpdate(input));
}

function main(): void {
  try {
    console.log(JSON.stringify(runSkillUsageFeedbackCli(process.argv.slice(2))));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

const entry = basename(process.argv[1] ?? "");
if (entry === "skill-usage-feedback-cli.ts" || entry === "skill-usage-feedback-cli.js") main();
