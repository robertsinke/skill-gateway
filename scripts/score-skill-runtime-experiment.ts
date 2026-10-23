import { basename } from "node:path";
import { parseArgs } from "node:util";
import { defaultRoots, loadMerged } from "../src/search.ts";
import { inspectSkillRuntimeBatch, prepareSkillRuntimeBatch, registerSkillRuntimeProtocol, reportSkillRuntimeBatch, scoreSkillRuntimeBatch } from "../src/skill-runtime-batch.ts";

const USAGE = `Local preparation:
  npm run eval:skill-runtime:batch -- --run <completed-U1-run> --output <fresh-private-batch-dir> [--library-root <dir>] [--protocol <registration-dir>]
Prospective registration (all known sessions become development-only; 30-day window):
  npm run eval:skill-runtime:batch -- --register --run <completed-U1-run> --output <fresh-registration-dir>
Dry-run preview (no credentials or network):
  npm run eval:skill-runtime:batch -- --batch <batch-dir>
Explicit scoring (requires separately reviewed approval file):
  npm run eval:skill-runtime:batch -- --batch <batch-dir> --execute --approval <approval.json>
Local paired report (no credentials/network; prospective reporting finalizes the test):
  npm run eval:skill-runtime:batch -- --batch <batch-dir> --report --output <fresh-private-report-dir>`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    help: { type: "boolean" }, register: { type: "boolean" }, execute: { type: "boolean" }, report: { type: "boolean" },
    run: { type: "string" }, output: { type: "string" }, protocol: { type: "string" },
    batch: { type: "string" }, approval: { type: "string" }, "library-root": { type: "string" },
  } });
  if (values.help) { console.log(USAGE); return; }
  let result: unknown;
  if (values.batch) {
    if (values.run || values.protocol || values.register || values["library-root"]
      || (!!values.execute !== !!values.approval)) throw new Error("Invalid batch mode options.");
    if (values.report) {
      if (!values.output || values.execute || values.approval) throw new Error("Invalid report options.");
      result = reportSkillRuntimeBatch(values.batch, values.output);
    } else {
      if (values.output) throw new Error("Output is only valid for report or preparation.");
      result = values.execute
        ? await scoreSkillRuntimeBatch(values.batch, values.approval!)
        : inspectSkillRuntimeBatch(values.batch);
    }
  } else {
    if (!values.run || !values.output || values.execute || values.approval || values.report) throw new Error("Invalid preparation options.");
    if (values.register) {
      if (values.protocol || values["library-root"]) throw new Error("Invalid registration options.");
      result = registerSkillRuntimeProtocol(values.run, values.output);
    } else {
      const catalog = loadMerged(values["library-root"] ? [values["library-root"]] : defaultRoots()).map((skill) => ({
        name: skill.document.name, description: skill.document.description,
      }));
      result = prepareSkillRuntimeBatch({ run: values.run, output: values.output, protocol: values.protocol, catalog });
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (basename(process.argv[1] ?? "") === "score-skill-runtime-experiment.ts") {
  main().catch(() => {
    // Never print OS/provider exceptions: they can contain private paths, bodies or credentials.
    console.error("Batch operation failed. Check --help, private artifact hashes/permissions, cohort eligibility, exact approval, budget, finalized reports, and unresolved attempts/locks. No attempt is automatically retried.");
    process.exitCode = 1;
  });
}
