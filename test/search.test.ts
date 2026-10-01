import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadMerged } from "../src/search.ts";

const SEARCH = fileURLToPath(new URL("../src/search.ts", import.meta.url));

function skill(root: string, directory: string, frontmatter: string, body = "# Body\n"): string {
  const folder = join(root, directory);
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), `---\n${frontmatter.trim()}\n---\n\n${body}`, "utf8");
  return realpathSync(folder);
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SEARCH, "--root", root, ...args], {
    encoding: "utf8",
  });
}

describe("search command", () => {
  it("returns the overlapping skill and omits the others", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const calendar = skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    skill(root, "inbox", "name: inbox\ndescription: read mail threads\n");
    skill(root, "notes", "name: notes\ndescription: capture a thought\n");
    const proc = run(root, "schedule the meeting");
    assert.equal(proc.status, 0, proc.stderr);
    const payload = JSON.parse(proc.stdout) as { results: { name: string; path: string; description: string; score: number }[] };
    assert.deepEqual(payload.results.map((hit) => hit.name), ["calendar"]);
    const hit = payload.results[0];
    assert.ok(hit);
    assert.equal(hit.path, calendar);
    assert.equal(hit.description, "schedule a meeting");
    assert.ok(hit.score > 0);
  });

  it("caps results at 20 and lets --limit tighten that", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    for (let index = 0; index < 25; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      skill(root, name, `name: ${name}\ndescription: alpha signal\n`);
    }
    skill(root, "unrelated", "name: unrelated\ndescription: ceramics\n");
    const defaults = run(root, "alpha signal");
    const tight = run(root, "--limit", "3", "alpha signal");
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.equal(JSON.parse(defaults.stdout).results.length, 20);
    assert.equal(tight.status, 0, tight.stderr);
    assert.equal(JSON.parse(tight.stdout).results.length, 3);
  });

  it("skips a directory without SKILL.md and returns the directory path", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(root, "empty-dir"));
    const folder = skill(root, "kw_probe", "name: kw:probe\ndescription: check a thing\n");
    const proc = run(root, "check a thing");
    assert.equal(proc.status, 0, proc.stderr);
    const results = JSON.parse(proc.stdout).results as { name: string; path: string }[];
    assert.deepEqual(results.map((hit) => hit.name), ["kw:probe"]);
    assert.equal(results[0]?.path, folder);
  });

  it("exits zero when the query normalizes to nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, "the and of");
    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(JSON.parse(proc.stdout), { results: [] });
  });

  it("looks up a known name and returns an empty list for an unknown name", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const folder = skill(root, "kw_probe", "name: kw:probe\ndescription: check a thing\n");
    const known = run(root, "--exact", "kw:probe");
    const unknown = run(root, "--exact", "missing-skill");
    assert.equal(known.status, 0, known.stderr);
    const hits = JSON.parse(known.stdout).results as { path: string }[];
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.path, folder);
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.deepEqual(JSON.parse(unknown.stdout), { results: [] });
  });

  it("rejects a missing root", () => {
    const missing = join(tmpdir(), "skills-gateway-missing-root");
    const proc = run(missing, "anything");
    assert.notEqual(proc.status, 0);
    assert.equal(proc.stdout.includes('"results"'), false);
    assert.ok(proc.stderr.trim());
  });

  it("skips an unreadable skill file", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const hidden = skill(root, "hidden", "name: hidden\ndescription: secret alpha\n");
    const kept = skill(root, "kept", "name: kept\ndescription: visible alpha\n");
    chmodSync(join(hidden, "SKILL.md"), 0);
    try {
      const proc = run(root, "alpha");
      assert.equal(proc.status, 0, proc.stderr);
      const results = JSON.parse(proc.stdout).results as { name: string; path: string }[];
      assert.deepEqual(results.map((hit) => hit.name), ["kept"]);
      assert.equal(results[0]?.path, kept);
    } finally {
      chmodSync(join(hidden, "SKILL.md"), 0o600);
    }
  });

  it("rereads a description edit on the next search", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const folder = skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const before = run(root, "ceramics");
    assert.deepEqual(JSON.parse(before.stdout).results, []);
    writeFileSync(join(folder, "SKILL.md"), "---\nname: calendar\ndescription: glaze ceramics\n---\n", "utf8");
    const after = run(root, "ceramics");
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(
      (JSON.parse(after.stdout).results as { name: string }[]).map((hit) => hit.name),
      ["calendar"],
    );
  });

  it("does not index the body or the target requests", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    skill(root, "calendar", "name: calendar\ndescription: ''\ntargets:\n  - zzzxenon\n", "zzzxenon appears only in the body\n");
    const proc = run(root, "zzzxenon");
    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(JSON.parse(proc.stdout), { results: [] });
  });

  it("reads a folded block description", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    skill(root, "calendar", "name: calendar\ndescription: >-\n  schedule a meeting\n  on the calendar\n");
    const proc = run(root, "schedule the meeting");
    assert.equal(proc.status, 0, proc.stderr);
    const hit = JSON.parse(proc.stdout).results[0] as { description: string };
    assert.match(hit.description, /schedule a meeting/);
    assert.match(hit.description, /on the calendar/);
  });

  it("keeps search-skills out of the ranked library", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    skill(root, "search-skills", "name: search-skills\ndescription: search the skill library\n");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const listed = run(root, "search the skill library");
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).results, []);
    const kept = run(root, "schedule a meeting");
    assert.deepEqual(
      (JSON.parse(kept.stdout).results as { name: string }[]).map((hit) => hit.name),
      ["calendar"],
    );
  });

  it("rejects a negative limit and a missing query", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const negative = run(root, "--limit", "-1", "meeting");
    assert.notEqual(negative.status, 0);
    const missing = spawnSync(process.execPath, ["--experimental-strip-types", SEARCH, "--root", root], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /pass a query or --exact/);
  });

  it("keeps the first name when two roots contain the same skill", () => {
    const first = mkdtempSync(join(tmpdir(), "skills-a-"));
    const second = mkdtempSync(join(tmpdir(), "skills-b-"));
    skill(first, "calendar", "name: calendar\ndescription: from the gateway\n");
    skill(second, "calendar", "name: calendar\ndescription: from the manager\n");
    const merged = loadMerged([first, second]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.document.description, "from the gateway");
  });
});
