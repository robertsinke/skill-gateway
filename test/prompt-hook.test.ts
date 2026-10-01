import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../src/prompt-hook.ts", import.meta.url));

function skill(root: string, directory: string, frontmatter: string): string {
  const folder = join(root, directory);
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), `---\n${frontmatter.trim()}\n---\n\n# Body\n`, "utf8");
  return realpathSync(folder);
}

function run(root: string, payload: unknown, env: NodeJS.ProcessEnv = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], {
    input: text,
    encoding: "utf8",
    env: {
      ...process.env,
      SKILL_GATEWAY_ROOT: root,
      SKILL_GATEWAY_LOG: "-",
      ...env,
    },
  });
}

describe("prompt hook", () => {
  it("injects a shortlist without copying the prompt into additional context", () => {
    const prompt = "please schedule the quarterly offsite";
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const folder = skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    skill(root, "inbox", "name: inbox\ndescription: read mail threads\n");
    const proc = run(root, { prompt });
    assert.equal(proc.status, 0, proc.stderr);
    const output = JSON.parse(proc.stdout);
    const context = output.hookSpecificOutput.additionalContext as string;
    assert.equal(context.includes(prompt), false);
    assert.match(context, /dist\/search\.js "<query>" --limit 10/);
    assert.match(context, /already loaded a listed skill, reuse it instead of reading it again/);
    assert.match(context, /has not been loaded earlier in this conversation/);
    assert.match(context, /calendar/);
    assert.match(context, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(context, /schedule a meeting/);
    assert.equal(context.includes("inbox"), false);
    assert.ok(output.systemMessage.startsWith(prompt));
    assert.ok(output.systemMessage.includes(context));
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  });

  it("injects the shortlist for Pi and leaves the system message empty", () => {
    const prompt = "please schedule the quarterly offsite";
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt, agent: "pi", transcript_path: "/tmp/.pi/agent/sessions/example.jsonl" });
    const output = JSON.parse(proc.stdout);
    const context = output.hookSpecificOutput.additionalContext as string;
    assert.equal(context.includes(prompt), false);
    assert.match(context, /calendar/);
    assert.equal(output.systemMessage, "");
  });

  it("uses the shortlist alone as the system message when a turn id is present", () => {
    const prompt = "please schedule the quarterly offsite";
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt, turn_id: "turn-1" });
    const output = JSON.parse(proc.stdout);
    assert.equal(output.systemMessage.includes(prompt), false);
    assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
    assert.match(output.systemMessage, /calendar/);
  });

  it("still explains how to search when the shortlist is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt: "purple zircon teapot" });
    const output = JSON.parse(proc.stdout);
    const context = output.hookSpecificOutput.additionalContext as string;
    assert.match(context, /shortlist is empty/);
    assert.match(context, /dist\/search\.js "<query>" --limit 10/);
    assert.equal(context.includes("calendar"), false);
    assert.ok(output.systemMessage.includes(context));
  });

  it("caps the shortlist at 20", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    for (let index = 0; index < 25; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      skill(root, name, `name: ${name}\ndescription: alpha signal\n`);
    }
    const proc = run(root, { userPrompt: "alpha signal" });
    const context = JSON.parse(proc.stdout).hookSpecificOutput.additionalContext as string;
    assert.equal(context.split("\n- ").length - 1, 20);
  });

  it("fails open on malformed JSON and a missing library", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "hook-")), "missing");
    for (const proc of [run(missing, "{"), run(missing, { prompt: "schedule a meeting" })]) {
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.systemMessage, "");
      assert.equal(output.hookSpecificOutput.additionalContext, "");
    }
  });

  it("records the user and session and leaves helped empty", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const logFile = join(root, "queries.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const proc = run(root, { prompt: "please schedule the quarterly offsite", session_id: "session-9" }, {
      SKILL_GATEWAY_LOG: logFile,
      SKILL_GATEWAY_USER: "robert",
    });
    assert.equal(proc.status, 0, proc.stderr);
    const entry = JSON.parse(readFileSync(logFile, "utf8"));
    assert.equal(entry.user_id, "robert");
    assert.equal(entry.session_id, "session-9");
    assert.equal(entry.query, "please schedule the quarterly offsite");
    assert.deepEqual(entry.ranks[0], { rank: 1, name: "calendar" });
    assert.ok(entry.skills.includes("calendar"));
    assert.equal(entry.selected, null);
    assert.equal(entry.completed, null);
    assert.equal(entry.followup, null);
    assert.equal(entry.helped, null);
    assert.ok(entry.date);
  });

  it("marks the previous search with the next message in the session", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const logFile = join(root, "queries.jsonl");
    skill(root, "calendar", "name: calendar\ndescription: schedule a meeting\n");
    const env = { SKILL_GATEWAY_LOG: logFile };
    for (const payload of [
      { prompt: "please schedule the quarterly offsite", session_id: "session-9" },
      { prompt: "thanks, that works", session_id: "session-9" },
    ]) {
      const proc = run(root, payload, env);
      assert.equal(proc.status, 0, proc.stderr);
    }
    const rows = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows[0].followup, "thanks, that works");
    assert.equal(rows[0].reaction, "positive");
    assert.equal(rows[1].followup, null);
  });

  it("fails open when the prompt is not a string", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-"));
    const proc = run(root, { prompt: ["not-a-string"] });
    const output = JSON.parse(proc.stdout);
    assert.equal(output.systemMessage, "");
    assert.equal(output.hookSpecificOutput.additionalContext, "");
  });
});
