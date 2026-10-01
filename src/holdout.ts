import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rank, type Document } from "./rank.ts";
import { DEFAULT_ROOT, SearchError, loadCatalog } from "./search.ts";

const CUTOFFS = [10, 20] as const;
export const DEFAULT_HOLDOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "holdout.json");

export class HoldoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutError";
  }
}

type Pair = { query: string; skill: string | null };

export function loadPairs(path: string): Pair[] {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new HoldoutError(`holdout file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(payload)) throw new HoldoutError("holdout file must be a list of pairs");
  return payload.map((pair, index) => {
    const number = index + 1;
    if (!pair || typeof pair !== "object" || Array.isArray(pair) || !("query" in pair) || typeof pair.query !== "string") {
      throw new HoldoutError(`holdout pair ${number} is missing its query`);
    }
    if (!("skill" in pair)) throw new HoldoutError(`holdout pair ${number} is missing its skill`);
    const skill = pair.skill;
    if (skill !== null && typeof skill !== "string") throw new HoldoutError(`holdout pair ${number} has an invalid skill`);
    return { query: pair.query, skill };
  });
}

export function score(documents: Document[], pairs: Pair[]): {
  recall_at_10: number | null;
  recall_at_20: number | null;
  hits_at_10: number;
  hits_at_20: number;
  denominator: number;
  drift: { query: string; skill: string }[];
  false_includes: { query: string }[];
} {
  const names = new Set(documents.map((document) => document.name.toLowerCase()));
  const hits = { 10: 0, 20: 0 };
  let denominator = 0;
  const drift: { query: string; skill: string }[] = [];
  const falseIncludes: { query: string }[] = [];
  for (const pair of pairs) {
    if (pair.skill === null) {
      if (rank(pair.query, documents, Math.max(documents.length, 1)).length > 0) falseIncludes.push({ query: pair.query });
      continue;
    }
    denominator += 1;
    if (!names.has(pair.skill.toLowerCase())) {
      drift.push({ query: pair.query, skill: pair.skill });
      continue;
    }
    for (const cutoff of CUTOFFS) {
      const shortlist = rank(pair.query, documents, cutoff);
      if (shortlist.some((hit) => hit.document.name.toLowerCase() === pair.skill?.toLowerCase())) hits[cutoff] += 1;
    }
  }
  return {
    recall_at_10: recall(hits[10], denominator),
    recall_at_20: recall(hits[20], denominator),
    hits_at_10: hits[10],
    hits_at_20: hits[20],
    denominator,
    drift,
    false_includes: falseIncludes,
  };
}

function recall(hits: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return hits / denominator;
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: "string", default: DEFAULT_ROOT }, holdout: { type: "string", default: DEFAULT_HOLDOUT } },
  });
  try {
    const pairs = loadPairs(values.holdout ?? DEFAULT_HOLDOUT);
    const documents = loadCatalog(values.root ?? DEFAULT_ROOT).map((skill) => skill.document);
    console.log(JSON.stringify(score(documents, pairs), null, 2));
    return 0;
  } catch (error) {
    if (error instanceof HoldoutError || error instanceof SearchError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (basename(process.argv[1] ?? "") === "holdout.ts" || basename(process.argv[1] ?? "") === "holdout.js") {
  process.exit(main(process.argv.slice(2)));
}
