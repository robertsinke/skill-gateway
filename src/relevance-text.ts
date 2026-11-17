import { suggestionBlock, type Skill } from "./vendor/jev-skill-suggestion/policy.ts";

/**
 * Context text for one selection. A completed choice is one ignorable tag.
 * A completed decision that nothing fits says so. A failed lookup is empty.
 * Shared by selectSkill and the suggestion hook.
 */
const SILENT_REASONS = new Set([
  "no answer",
  "credential_unavailable",
  "skill_excerpt_permission_required",
  "not_an_implicit_skill_request",
  "no_candidates",
  "context_changed",
  "disable-model-invocation",
]);

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function relevanceText(name: string | null, reason: string): string {
  if (SILENT_REASONS.has(reason) || reason.startsWith("rerank gave no answer")) return "";
  const skill: Skill | null = name ? { name: xmlText(name), description: "" } : null;
  return suggestionBlock(skill, false) ?? "";
}
