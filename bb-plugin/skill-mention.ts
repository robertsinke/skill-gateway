export const SKILL_MENTION_MARKER = "<!-- skill-gateway-selected-skill -->";

export type GatewayToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
};

export type GatewayToolCall = (name: "skills_suggest_library" | "skills_read_skill", args: Record<string, unknown>) => Promise<GatewayToolResult>;

type Suggestion = { name: string; description: string };

function suggestionsFrom(result: GatewayToolResult): Suggestion[] {
  if (result.isError) throw new Error("Skill Gateway suggestion search failed");
  const data = result.structuredContent as { results?: unknown } | undefined;
  if (!Array.isArray(data?.results)) return [];
  return data.results.flatMap((item): Suggestion[] =>
    item && typeof item === "object" && "name" in item && typeof item.name === "string" && item.name.length <= 200
      && "description" in item && typeof item.description === "string"
      ? [{ name: item.name, description: item.description }]
      : [],
  );
}

function readContentFrom(result: GatewayToolResult, expectedName: string): string {
  if (result.isError) throw new Error("Skill Gateway could not read the selected skill");
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Skill Gateway returned no skill content");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Skill Gateway returned an invalid skill document");
  }
  if (!data || typeof data !== "object" || !("name" in data) || data.name !== expectedName || !("content" in data) || typeof data.content !== "string") {
    throw new Error("Skill Gateway returned a different or invalid skill");
  }
  return data.content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u, "").trim();
}

/** BB's mention contract supplies only metadata while searching and resolves one body at send time. */
export function createSkillMentionProvider(callTool: GatewayToolCall) {
  return {
    id: "skill-library",
    label: "Skills",
    triggers: ["~"] as const,
    async search({ query }: { query: string }) {
      const result = await callTool("skills_suggest_library", { query, limit: 20 });
      return suggestionsFrom(result).map(({ name, description }) => ({
        id: encodeURIComponent(name),
        title: name,
        subtitle: description,
      }));
    },
    async resolve(itemId: string) {
      let name: string;
      try {
        name = decodeURIComponent(itemId);
      } catch {
        throw new Error("Invalid selected skill reference");
      }
      if (!name || name.length > 200) throw new Error("Invalid selected skill reference");
      const result = await callTool("skills_read_skill", { name, response_format: "json" });
      const body = readContentFrom(result, name);
      if (!body) throw new Error(`Skill ${JSON.stringify(name)} has no instructions`);
      return { context: `${SKILL_MENTION_MARKER}\n${name}\n\n${body}` };
    },
  };
}
