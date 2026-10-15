import { homedir } from "node:os";
import { basename } from "node:path";
import { buildUsageTurnDataset, readJsonl, writeUsageTurnDataset } from "../src/usage-turn-dataset.ts";

function main(): void {
  const dataDir = `${homedir()}/.local/share/skill-gateway`;
  const eventPath = process.env.SKILL_GATEWAY_EVENTS ?? `${dataDir}/usage-events.jsonl`;
  const queryPath = process.env.SKILL_GATEWAY_LOG ?? `${dataDir}/queries.jsonl`;
  const feedbackPath = process.env.SKILL_GATEWAY_FEEDBACK ?? `${dataDir}/skill-usage-feedback.jsonl`;
  const outputPath = process.env.SKILL_GATEWAY_TURN_DATASET ?? `${dataDir}/usage-turn-dataset-v2.jsonl`;
  const result = buildUsageTurnDataset(readJsonl(eventPath), readJsonl(queryPath), readJsonl(feedbackPath));
  writeUsageTurnDataset(result.rows, result.metadata, outputPath);
  console.log(JSON.stringify({ output: outputPath, ...result.metadata }, null, 2));
}

if (basename(process.argv[1] ?? "") === "build-usage-turn-dataset.ts") main();
