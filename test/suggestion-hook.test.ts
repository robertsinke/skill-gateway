import assert from "node:assert/strict";
import test from "node:test";
import { handle, suggestionText } from "../src/suggestion-hook.ts";

test("a chosen skill is one ignorable line", () => {
  const text = suggestionText("tdd", "rerank of 3, fits 0.80");
  assert.match(text, /Relevant to the current request: tdd\./);
  assert.match(text, /Ignore this if it does not fit/);
  assert.doesNotMatch(text, /withheld/);
  assert.doesNotMatch(text, /instructions follow/);
});

test("a completed no is said out loud", () => {
  const text = suggestionText(null, "needs a skill 0.10 < 0.3");
  assert.match(text, /No skill in the roster appears relevant/);
});

test("a failed lookup adds nothing", () => {
  assert.equal(suggestionText(null, "no answer"), "");
  assert.equal(suggestionText(null, "credential_unavailable"), "");
  assert.equal(suggestionText(null, "rerank gave no answer; no suggestion"), "");
  assert.equal(suggestionText("tdd", "disable-model-invocation"), "");
});

test("a thrown selector adds nothing", async () => {
  const output = await handle({ prompt: "write a failing test first" }, async () => {
    throw new Error("down");
  });
  assert.equal(JSON.parse(output).hookSpecificOutput.additionalContext, "");
});

test("the hook prints that line as additional context", async () => {
  const output = await handle(
    { prompt: "write a failing test first" },
    async () => ({ name: "tdd", reason: "rerank of 1, fits 0.90" }),
  );
  const parsed = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(parsed.hookSpecificOutput.additionalContext, /tdd/);
});

function withBbSession(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.SKILL_GATEWAY_BB_SESSION;
  if (value === undefined) delete process.env.SKILL_GATEWAY_BB_SESSION;
  else process.env.SKILL_GATEWAY_BB_SESSION = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env.SKILL_GATEWAY_BB_SESSION;
    else process.env.SKILL_GATEWAY_BB_SESSION = previous;
  });
}

test("the hook stands down when the payload session is the BB-owned session", async () => {
  await withBbSession("sess-1", async () => {
    let called = false;
    const output = await handle({ prompt: "write a failing test first", session_id: "sess-1" }, async () => {
      called = true;
      throw new Error("must not run");
    });
    assert.equal(called, false);
    assert.equal(JSON.parse(output).hookSpecificOutput.additionalContext, "");
  });
});

test("a different session still gets the name tag", async () => {
  await withBbSession("sess-1", async () => {
    let called = false;
    const output = await handle({ prompt: "write a failing test first", session_id: "sess-2" }, async () => {
      called = true;
      return { name: "tdd", reason: "rerank of 1, fits 0.90" };
    });
    assert.equal(called, true);
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /Relevant to the current request: tdd\./);
  });
});

test("a payload with no session id still calls the selector", async () => {
  await withBbSession("sess-1", async () => {
    let called = false;
    const output = await handle({ prompt: "write a failing test first" }, async () => {
      called = true;
      return { name: "tdd", reason: "rerank of 1, fits 0.90" };
    });
    assert.equal(called, true);
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /tdd/);
  });
});

test("an unset BB session still wraps the tag", async () => {
  await withBbSession(undefined, async () => {
    const output = await handle({ prompt: "write a failing test first", session_id: "sess-1" }, async () => ({
      name: "tdd",
      reason: "rerank of 1, fits 0.90",
    }));
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /Relevant to the current request: tdd\./);
  });
});

test("an empty prompt does not call the selector", async () => {
  let called = false;
  const output = await handle({ prompt: "  " }, async () => {
    called = true;
    return { name: "tdd", reason: "rerank of 1" };
  });
  assert.equal(called, false);
  assert.equal(JSON.parse(output).hookSpecificOutput.additionalContext, "");
});
