import { homedir } from "node:os";
import { basename, join } from "node:path";
import { runSkillRuntimeExperiment } from "../src/skill-runtime-experiment.ts";

const USAGE = "Usage: npm run eval:skill-runtime -- --output <fresh-directory-outside-repo> [--events <file>] [--queries <file>] [--feedback <file>]";

export function main(args = process.argv.slice(2)): void {
  if (args.length === 1 && args[0] === "--help") { console.log(USAGE); return; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !["--output", "--events", "--queries", "--feedback"].includes(flag)
      || !value || value.startsWith("--") || options.has(flag)) throw new Error(USAGE);
    options.set(flag, value);
  }
  const output = options.get("--output");
  if (!output) throw new Error(USAGE);
  const dataDir = join(homedir(), ".local/share/skill-gateway");
  const report = runSkillRuntimeExperiment({
    events: options.get("--events") ?? process.env.SKILL_GATEWAY_EVENTS ?? join(dataDir, "usage-events.jsonl"),
    queries: options.get("--queries") ?? process.env.SKILL_GATEWAY_LOG ?? join(dataDir, "queries.jsonl"),
    feedback: options.get("--feedback") ?? process.env.SKILL_GATEWAY_FEEDBACK ?? join(dataDir, "skill-usage-feedback.jsonl"),
  }, output);
  console.log(JSON.stringify(report, null, 2));
}

if (basename(process.argv[1] ?? "") === "evaluate-skill-runtime.ts") {
  try { main(); }
  catch {
    // OS/JSON errors may embed source paths or content. Do not expose those on stdout/stderr.
    console.error("Local experiment failed. Check required nonempty JSONL sources and a fresh output directory outside the repository with an existing parent. Existing runs are never overwritten. Use --help for options.");
    process.exitCode = 1;
  }
}
