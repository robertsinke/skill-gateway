import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type LaunchdJob = { label: string; path: string };

const LABEL = /<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/;

/**
 * Finds a LaunchAgent that already runs the given server entrypoint, so the
 * plugin does not start a second copy of a process launchd supervises.
 * Binary plists are skipped rather than guessed at.
 */
export function launchdJobForServer(
  entry: string,
  options: { home?: string; directories?: string[] } = {},
): LaunchdJob | null {
  const home = options.home ?? homedir();
  const directories = options.directories ?? [join(home, "Library", "LaunchAgents"), "/Library/LaunchAgents"];
  const target = resolve(entry);
  const basename = target.split("/").pop() ?? target;
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith(".plist"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(directory, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (text.startsWith("bplist")) continue;
      const strings = [...text.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? "");
      const runsEntry = strings.some((value) => {
        const trimmed = value.trim();
        if (!trimmed || trimmed.includes("\n")) return false;
        if (resolve(trimmed) === target) return true;
        return trimmed.endsWith(`/${basename}`) && trimmed.includes("skill-gateway");
      });
      if (!runsEntry) continue;
      return { label: LABEL.exec(text)?.[1]?.trim() ?? name.replace(/\.plist$/, ""), path };
    }
  }
  return null;
}
