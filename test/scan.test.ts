import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gather, libraryDir, removeCopies } from "../src/scan.ts";

describe("scan", () => {
  it("copies agent skills and leaves the library copy when extras are removed", () => {
    const home = mkdtempSync(join(tmpdir(), "scan-"));
    const folder = join(home, ".cursor", "skills", "calendar");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "---\nname: calendar\ndescription: book time\n---\n", "utf8");
    const manager = join(home, ".skills-manager", "skills", "vault");
    mkdirSync(manager, { recursive: true });
    writeFileSync(join(manager, "SKILL.md"), "---\nname: vault\ndescription: keep secrets\n---\n", "utf8");
    const report = gather(home);
    const library = libraryDir(home);
    assert.deepEqual(report.imported, ["calendar", "vault"]);
    assert.equal(existsSync(join(library, "calendar", "SKILL.md")), true);
    assert.deepEqual(report.removable, [{ name: "calendar", path: folder, place: "Cursor" }]);
    const removed = removeCopies([folder, manager], home);
    assert.deepEqual(removed.removed, [folder]);
    assert.deepEqual(removed.refused, [manager]);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(join(library, "calendar", "SKILL.md")), true);
    assert.equal(existsSync(join(manager, "SKILL.md")), true);
    const claude = join(home, ".claude", "skills", "calendar");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "SKILL.md"), "---\nname: calendar\ndescription: book time\n---\n", "utf8");
    const again = gather(home);
    const claudeRow = again.sources.find((row) => row.relative === ".claude/skills");
    assert.equal(claudeRow?.duplicates, 1);
    assert.equal(again.duplicates[0]?.name, "calendar");
    assert.equal(again.duplicates[0]?.kept, "Cursor");
    assert.equal(again.duplicates[0]?.place, "Claude");
    assert.deepEqual(again.imported, []);
  });
});
