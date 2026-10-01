import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lookupSkill, readSkill, searchLibrary } from "../src/mcp.ts";

function skill(root: string, directory: string, description: string): void {
  const folder = join(root, directory);
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${directory}\ndescription: ${description}\n---\n`, "utf8");
}

describe("mcp tools", () => {
  it("returns a markdown shortlist and a JSON page", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-"));
    skill(root, "calendar", "schedule a meeting");
    skill(root, "inbox", "read mail threads");
    const markdown = searchLibrary("schedule the meeting", { root });
    assert.match(markdown, /# Skill shortlist/);
    assert.match(markdown, /calendar/);
    assert.match(markdown, /schedule a meeting/);
    assert.equal(markdown.includes("inbox"), false);
    const payload = JSON.parse(searchLibrary("schedule the meeting", { root, format: "json" }));
    assert.equal(payload.total, 1);
    assert.equal(payload.count, 1);
    assert.equal(payload.offset, 0);
    assert.equal(payload.limit, 20);
    assert.equal(payload.has_more, false);
    assert.equal(payload.next_offset, null);
    assert.equal(payload.results[0].name, "calendar");
    assert.equal(payload.results[0].description, "schedule a meeting");
    assert.ok(payload.results[0].score > 0);
  });

  it("pages ranked hits and looks up one named skill", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-"));
    for (let index = 0; index < 3; index += 1) {
      skill(root, `skill-${index}`, "alpha signal");
    }
    const page = JSON.parse(searchLibrary("alpha signal", { root, limit: 2, offset: 0, format: "json" }));
    assert.equal(page.count, 2);
    assert.equal(page.total, 3);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 2);
    const last = JSON.parse(searchLibrary("alpha signal", { root, limit: 2, offset: 2, format: "json" }));
    assert.equal(last.count, 1);
    assert.equal(last.has_more, false);
    assert.equal(last.next_offset, null);
    const found = JSON.parse(lookupSkill("skill-1", { root, format: "json" }));
    assert.equal(found.total, 1);
    assert.equal(found.results[0].score, 1);
  });

  it("returns an empty result for an unknown or ambiguous name", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-"));
    skill(root, "left", "one");
    writeFileSync(join(root, "left", "SKILL.md"), "---\nname: shared\ndescription: one\n---\n", "utf8");
    skill(root, "shared", "two");
    writeFileSync(join(root, "shared", "SKILL.md"), "---\nname: other\ndescription: two\n---\n", "utf8");
    const unknown = JSON.parse(lookupSkill("missing-skill", { root, format: "json" }));
    assert.equal(unknown.total, 0);
    const clash = JSON.parse(lookupSkill("shared", { root, format: "json" }));
    assert.equal(clash.total, 0);
  });

  it("returns an error string when the library is missing", () => {
    const missing = join(tmpdir(), "mcp-missing-library");
    const text = searchLibrary("anything", { root: missing });
    assert.match(text, /^Error:/);
    assert.match(text, /SKILL_GATEWAY_ROOT/);
  });

  it("reads one unambiguous skill through the MCP surface", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-"));
    const folder = join(root, "calendar");
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), "---\nname: calendar\ndescription: schedule\n---\n\nUse the calendar.\n", "utf8");
    const markdown = readSkill("calendar", { root });
    assert.match(markdown, /Use the calendar\./);
    const json = JSON.parse(readSkill("calendar", { root, format: "json" }));
    assert.equal(json.name, "calendar");
    assert.match(json.content, /Use the calendar\./);
  });

  it("sees a description edit on the next call", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-"));
    skill(root, "calendar", "schedule a meeting");
    assert.equal(JSON.parse(searchLibrary("ceramics", { root, format: "json" })).total, 0);
    writeFileSync(join(root, "calendar", "SKILL.md"), "---\nname: calendar\ndescription: glaze ceramics\n---\n", "utf8");
    const after = JSON.parse(searchLibrary("ceramics", { root, format: "json" }));
    assert.equal(after.results[0].name, "calendar");
  });
});
