import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { handleSkillLoad } from "../src/skill-load-hook.ts";

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), "skill-load-")), "library");
  const folder = join(root, "calendar");
  mkdirSync(folder, { recursive: true });
  const skillPath = join(folder, "SKILL.md");
  writeFileSync(skillPath, "---\nname: calendar\ndescription: Schedule meetings\n---\n", "utf8");
  return { root, skillPath };
}

describe("skill load hook", () => {
  it("records only verified skill-file reads with session and turn correlation", () => {
    const { root, skillPath } = fixture();
    const eventsPath = join(root, "usage-events.jsonl");
    const count = handleSkillLoad({
      session_id: "session-1",
      turn_id: "turn-4",
      turn_id_source: "pi_hooks_use_bridge",
      tool_use_id: "call-9",
      agent: "pi",
      tool_name: "Read",
      tool_input: { file_path: skillPath },
      tool_response: "private skill body should not be recorded",
    }, { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsPath });

    assert.equal(count, 1);
    const event = JSON.parse(readFileSync(eventsPath, "utf8"));
    assert.equal(event.event_type, "skill_load");
    assert.equal(event.skill_name, "calendar");
    assert.equal(event.session_id, "session-1");
    assert.equal(event.turn_id, "turn-4");
    assert.equal(event.turn_id_source, "pi_hooks_use_bridge");
    assert.equal(event.tool_call_id, "call-9");
    assert.equal(event.platform, "pi");
    assert.equal(event.source, "hooks_use_post_tool_use");
    assert.equal(JSON.stringify(event).includes(skillPath), false);
    assert.equal(JSON.stringify(event).includes("private skill body"), false);
  });

  it("records named skill-reader tools but ignores unrelated paths and unknown skills", () => {
    const { root } = fixture();
    const eventsPath = join(root, "usage-events.jsonl");
    const env = { ...process.env, SKILL_GATEWAY_ROOT: root, SKILL_GATEWAY_EVENTS: eventsPath };
    assert.equal(handleSkillLoad({ tool_name: "mcp__skill_gateway__skills_read_skill", tool_input: { name: "calendar" } }, env), 1);
    assert.equal(handleSkillLoad({ tool_name: "Read", tool_input: { file_path: "/tmp/other/library/calendar/SKILL.md" } }, env), 0);
    assert.equal(handleSkillLoad({ tool_name: "skills_read_skill", tool_input: { name: "missing" } }, env), 0);
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].skill_name, "calendar");
  });
});
