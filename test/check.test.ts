import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { saveTargets } from "../src/check.ts";
import { suggestMessages } from "../src/query-log.ts";
import { provenance } from "../src/sources.ts";

const CHECK = fileURLToPath(new URL("../src/check.ts", import.meta.url));

function skill(root: string, directory: string, frontmatter: string): string {
  const folder = join(root, directory);
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), `---\n${frontmatter.trim()}\n---\n\n# Body\n`, "utf8");
  return folder;
}

function run(root: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CHECK, "--root", root], { encoding: "utf8" });
}

describe("description check", () => {
  it("marks a matching description green", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting and book time and glaze ceramics\ntargets:\n  - schedule a meeting\n  - book time\n  - glaze ceramics\n");
    skill(root, "inbox", "name: inbox\ndescription: read mail threads\n");
    const proc = run(root);
    assert.equal(proc.status, 0, proc.stderr);
    const payload = JSON.parse(proc.stdout);
    assert.deepEqual(payload.green, ["calendar"]);
    assert.deepEqual(payload.red, []);
  });

  it("marks rank 11 red and names the skills above", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    const neighbors: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const name = `neighbor-${String(index).padStart(2, "0")}`;
      neighbors.push(name);
      skill(root, name, `name: ${name}\ndescription: zebra signal\n`);
    }
    skill(root, "subject", "name: subject\ndescription: zebra schedule a meeting and book time\ntargets:\n  - zebra signal\n  - schedule a meeting\n  - book time\n");
    const proc = run(root);
    assert.equal(proc.status, 0, proc.stderr);
    const payload = JSON.parse(proc.stdout);
    assert.deepEqual(payload.green, []);
    assert.equal(payload.red.length, 1);
    assert.equal(payload.red[0].name, "subject");
    assert.equal(payload.red[0].failures.length, 1);
    assert.equal(payload.red[0].failures[0].target, "zebra signal");
    assert.equal(payload.red[0].failures[0].rank, 11);
    assert.deepEqual(payload.red[0].failures[0].above, neighbors);
  });

  it("skips a skill without three targets", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    skill(root, "notes", "name: notes\ndescription: capture a thought\n");
    skill(root, "two", "name: two\ndescription: alpha\ntargets:\n  - alpha\n  - beta\n");
    const payload = JSON.parse(run(root).stdout);
    assert.deepEqual(payload.red, []);
    assert.deepEqual(payload.green, []);
    assert.deepEqual(payload.skipped, ["notes", "two"]);
  });

  it("does not treat targets as part of the document", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    skill(root, "hollow", 'name: hollow\ndescription: ""\ntargets:\n  - zzzxenon\n  - zzzxenon\n  - zzzxenon\n');
    const payload = JSON.parse(run(root).stdout);
    assert.deepEqual(payload.green, []);
    assert.equal(payload.red[0].name, "hollow");
  });

  it("marks a stopword target red instead of crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting and book time\ntargets:\n  - the and of\n  - schedule a meeting\n  - book time\n");
    const failure = JSON.parse(run(root).stdout).red[0].failures[0];
    assert.equal(failure.target, "the and of");
    assert.equal(failure.rank, null);
  });

  it("turns red into green after the description is edited", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    const folder = skill(root, "calendar", 'name: calendar\ndescription: ""\ntargets:\n  - schedule a meeting\n  - book time\n  - glaze ceramics\n');
    const before = JSON.parse(run(root).stdout);
    assert.equal(before.red[0].name, "calendar");
    const original = readFileSync(join(folder, "SKILL.md"), "utf8");
    writeFileSync(join(folder, "SKILL.md"), original.replace('description: ""', "description: schedule a meeting and book time and glaze ceramics"), "utf8");
    const after = JSON.parse(run(root).stdout);
    assert.deepEqual(after.green, ["calendar"]);
    assert.deepEqual(after.red, []);
    const rewritten = readFileSync(join(folder, "SKILL.md"), "utf8");
    assert.match(rewritten, /schedule a meeting/);
    assert.match(rewritten, /book time/);
    assert.match(rewritten, /glaze ceramics/);
    assert.equal(rewritten.split("- ").length - 1, 3);
  });

  it("saves three messages and leaves the body alone", () => {
    const root = mkdtempSync(join(tmpdir(), "check-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\ntargets:\n  - one\n  - two\n  - three\n");
    saveTargets(root, "calendar", ["book a room", "schedule tomorrow", 'say "hello"']);
    const text = readFileSync(join(root, "calendar", "SKILL.md"), "utf8");
    assert.match(text, /# Body/);
    assert.match(text, /say \\"hello\\"/);
  });
});

describe("provenance and suggestions", () => {
  it("maps source columns", () => {
    assert.deepEqual(provenance("skillssh", "mattpocock/skills/wizard", ""), { source: "skills.sh", owner: "mattpocock" });
    assert.deepEqual(provenance("git", "", "https://github.com/EveryInc/compound-engineering-plugin.git"), {
      source: "GitHub",
      owner: "EveryInc/compound-engineering-plugin",
    });
    assert.deepEqual(provenance("local", "/tmp/today", ""), { source: "local", owner: "" });
  });

  it("suggests queries that returned the skill", () => {
    const rows = [
      { query: "refresh today's note", skills: ["today", "note-taking"] },
      { query: "refresh today's note", skills: ["today"] },
      { query: "write a skill", skills: ["open-knowledge-write-skill"] },
      { query: "start my day", skills: ["note-taking", "today"] },
    ];
    assert.deepEqual(suggestMessages(rows, "today"), ["refresh today's note", "start my day"]);
  });
});
