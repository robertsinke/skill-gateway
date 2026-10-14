import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { Skill } from "../src/search.ts";
import { pointerContent, syncCodexSkillPointers as syncPointers } from "../src/codex-pointers.ts";

function skill(name: string, description: string): Skill {
  return { document: { name, description, path: `/private/library/${name}` }, targets: [] };
}

describe("Codex metadata-only skill pointers", () => {
  it("creates native skills with metadata and a safe MCP read reference, never the library body", () => {
    const output = mkdtempSync(join(tmpdir(), "codex-pointer-"));
    const target = skill("kw:plan", "Structure a plan");
    const paths = syncPointers(output, [target]);
    assert.equal(paths.length, 1);
    const content = readFileSync(paths[0]!, "utf8");
    assert.match(content, /name: "kw:plan"/);
    assert.match(content, /description: "Structure a plan"/);
    assert.match(content, /skills_read_skill/);
    assert.match(content, /"kw:plan"/);
    assert.doesNotMatch(content, /private\/library/);
    assert.doesNotMatch(content, /SKILL BODY/);
  });

  it("escapes metadata and aliases names that exceed Codex's name limit", () => {
    const content = pointerContent(skill("x".repeat(80), "line one\nline two: \"quoted\""));
    assert.match(content, /name: "gateway-[a-f0-9]{16}"/);
    assert.match(content, /line one\\nline two: \\\"quoted\\\"/);
    assert.match(content, /"x{80}"/);
  });

  it("removes only stale pointer directories it previously created", () => {
    const output = mkdtempSync(join(tmpdir(), "codex-pointer-"));
    const oldPath = syncPointers(output, [skill("old-skill", "Old")])[0]!;
    const custom = join(output, "user-skill");
    mkdirSync(custom);
    writeFileSync(join(custom, "SKILL.md"), "keep me", "utf8");

    syncPointers(output, [skill("new-skill", "New")]);
    assert.equal(existsSync(oldPath), false);
    assert.equal(readFileSync(join(custom, "SKILL.md"), "utf8"), "keep me");
  });

  it("preserves a pointer changed by the user", () => {
    const output = mkdtempSync(join(tmpdir(), "codex-pointer-"));
    const pointer = syncPointers(output, [skill("same", "First")])[0]!;
    writeFileSync(pointer, "user edit", "utf8");
    assert.throws(() => syncPointers(output, [skill("same", "Changed")]), /modified Codex skill pointer/);
    assert.equal(readFileSync(pointer, "utf8"), "user edit");
  });

  it("refuses to overwrite an existing skill not owned by the generator", () => {
    const output = mkdtempSync(join(tmpdir(), "codex-pointer-"));
    const collision = syncPointers(output, [skill("same", "First")])[0]!;
    writeFileSync(join(dirname(collision), ".skill-gateway-pointer"), "user edit", "utf8");
    writeFileSync(collision, "user edit", "utf8");
    assert.throws(() => syncPointers(output, [skill("same", "Changed")]), /refusing to overwrite/);
    assert.equal(readFileSync(collision, "utf8"), "user edit");
  });
});
