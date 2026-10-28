import { basename } from "node:path";
import { parseArgs } from "node:util";
import { defaultRoots, loadMerged } from "../src/search.ts";
import type { RerankJudgment } from "../src/skill-rerank.ts";
import { prepareRerankEvaluation, previewRerankEvaluation, reportRerankEvaluation, scoreRerankEvaluation } from "../src/skill-rerank-evaluation.ts";

const USAGE = `Prepare locally: npm run eval:skill-rerank -- --run <completed-U1-run> --output <fresh-private-directory> [--library-root <dir>] [--judgment current-v1|relevance-v2]
Preview locally: npm run eval:skill-rerank -- --batch <directory>
Score only when authorized: npm run eval:skill-rerank -- --batch <directory> --execute --max-cost-usd <estimated-budget>
Report locally: npm run eval:skill-rerank -- --batch <directory> --report --output <fresh-private-directory>`;

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    run: { type: "string" }, output: { type: "string" }, batch: { type: "string" }, "library-root": { type: "string" }, judgment: { type: "string" },
    execute: { type: "boolean" }, report: { type: "boolean" }, "max-cost-usd": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(USAGE); return; }
  const judgment = values.judgment ?? "current-v1";
  if (judgment !== "current-v1" && judgment !== "relevance-v2") throw new Error("Unknown judgment.");
  let result: unknown;
  if (values.batch) {
    if (values.run || values["library-root"] || values.judgment || (values.execute && values.report)) throw new Error("Invalid batch mode.");
    if (values.execute) {
      if (!values["max-cost-usd"] || values.output) throw new Error("Explicit execution requires a budget.");
      result = await scoreRerankEvaluation(values.batch, { maxCostUsd: Number(values["max-cost-usd"]) });
    } else {
      if (values["max-cost-usd"]) throw new Error("Budget is valid only for execution.");
      if (values.report) {
        if (!values.output) throw new Error("Report output required.");
        result = reportRerankEvaluation(values.batch, values.output);
      } else {
        if (values.output) throw new Error("Unexpected output.");
        result = previewRerankEvaluation(values.batch);
      }
    }
  } else {
    if (!values.run || !values.output || values.execute || values.report || values["max-cost-usd"]) throw new Error("Source snapshot and output required.");
    const catalog = loadMerged(values["library-root"] ? [values["library-root"]] : defaultRoots()).map(({ document }) => ({ name: document.name, description: document.description }));
    result = prepareRerankEvaluation(values.run, values.output, catalog, judgment as RerankJudgment);
  }
  console.log(JSON.stringify(result, null, 2));
}
if (basename(process.argv[1] ?? "") === "evaluate-skill-rerank.ts") main().catch(() => {
  console.error("Rerank evaluation failed. Check --help, snapshot integrity, a fresh private output, budget, and interrupted attempts. No automatic retries; no production change.");
  process.exitCode = 1;
});
