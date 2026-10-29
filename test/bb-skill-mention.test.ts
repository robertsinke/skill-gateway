import assert from "node:assert/strict";
import test from "node:test";
import { createSkillMentionProvider, SKILL_MENTION_MARKER, type GatewayToolCall } from "../bb-plugin/skill-mention.ts";

test("BB skill mentions expose metadata in search and resolve only the selected body", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool: GatewayToolCall = async (name, args) => {
    calls.push({ name, args });
    if (name === "skills_suggest_library") {
      return {
        structuredContent: { results: [
          { name: "kw:plan", description: "Plan knowledge work" },
          { name: "bad", description: 17 },
        ] },
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          name: "kw:plan",
          path: "/private/library/kw_plan/SKILL.md",
          content: "---\nname: kw:plan\ndescription: Plan knowledge work\n---\n\nMake a plan.",
        }),
      }],
    };
  };
  const provider = createSkillMentionProvider(callTool);

  assert.deepEqual(provider.triggers, ["~"]);
  const items = await provider.search({ query: "plan" });
  assert.deepEqual(items, [{ id: "kw%3Aplan", title: "kw:plan", subtitle: "Plan knowledge work" }]);
  assert.deepEqual(calls[0], { name: "skills_suggest_library", args: { query: "plan", limit: 20 } });

  const resolved = await provider.resolve(items[0]!.id);
  assert.deepEqual(resolved, { context: `${SKILL_MENTION_MARKER}\nkw:plan\n\nMake a plan.` });
  assert.deepEqual(calls[1], { name: "skills_read_skill", args: { name: "kw:plan", response_format: "json" } });
});

test("BB skill mention refuses a mismatched selected skill", async () => {
  const provider = createSkillMentionProvider(async () => ({
    content: [{ type: "text", text: JSON.stringify({ name: "other", content: "not selected" }) }],
  }));
  await assert.rejects(() => provider.resolve("wanted"), /different or invalid skill/);
});
