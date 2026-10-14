import { parseArgs } from "node:util";
import { loadCatalog } from "../src/search.ts";
import { syncCodexSkillPointers } from "../src/codex-pointers.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    root: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: node --experimental-strip-types scripts/sync-codex-skill-pointers.ts --output <codex-skill-root> [--root <library-root>]");
  process.exit(0);
}

if (!values.output?.trim()) {
  console.error("--output is required; choose a Codex skill root such as ~/.agents/skills");
  process.exit(2);
}

try {
  const files = values.root
    ? syncCodexSkillPointers(values.output, loadCatalog(values.root))
    : syncCodexSkillPointers(values.output);
  console.log(`Synced ${files.length} metadata-only Codex skill pointers to ${values.output}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
