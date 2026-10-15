import { randomUUID, createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const DEFAULT_USAGE_EVENTS = `${homedir()}/.local/share/skill-gateway/usage-events.jsonl`;

export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function appendUsageEvent(event: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const path = (env.SKILL_GATEWAY_EVENTS ?? DEFAULT_USAGE_EVENTS).trim();
  if (!path || path === "-") return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify({
    ...event,
    schema_version: 1,
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
