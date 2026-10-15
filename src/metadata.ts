import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type SkillMetadata = {
  capabilities?: string[];
  aliases?: string[];
  avoid_when?: string[];
};

const paths = [
  `${homedir()}/.local/share/skill-gateway/skill-capabilities.json`,
  fileURLToPath(new URL("../skill-capabilities.json", import.meta.url)),
];

export function metadataPath(): string {
  return paths.find((candidate) => existsSync(candidate)) ?? paths[0]!;
}

export function loadMetadata(): Record<string, SkillMetadata> {
  const path = metadataPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, SkillMetadata>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function enrichedDescription(name: string, description: string, includeAvoidWhen = false, catalog = loadMetadata()): string {
  const metadata = catalog[name];
  if (!metadata) return description;
  const sections = [description || "No description provided."];
  if (metadata.capabilities?.length) sections.push(`Capabilities: ${metadata.capabilities.join("; ")}.`);
  if (metadata.aliases?.length) sections.push(`Also applies to: ${metadata.aliases.join(", ")}.`);
  if (includeAvoidWhen && metadata.avoid_when?.length) sections.push(`Avoid when: ${metadata.avoid_when.join("; ")}.`);
  return sections.join(" ");
}

export function saveMetadata(metadata: Record<string, SkillMetadata>): void {
  const path = metadataPath();
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function validateMetadata(value: unknown): SkillMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata must be an object");
  const input = value as Record<string, unknown>;
  const list = (key: string): string[] => {
    const raw = input[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error(`${key} must be an array`);
    return raw.map((item) => String(item).trim()).filter(Boolean).slice(0, 50);
  };
  return { capabilities: list("capabilities"), aliases: list("aliases"), avoid_when: list("avoid_when") };
}
