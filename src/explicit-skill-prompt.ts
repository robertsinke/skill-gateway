export const SKILL_MENTION_MARKER = "<!-- skill-gateway-selected-skill -->";

/** A slash command, a skill tag, or a resolved mention already names a skill. */
export function explicitSkillPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return /^\/\S/.test(text) || /^<skill name="[^"]+" location="/.test(text) || text.includes(SKILL_MENTION_MARKER);
}
