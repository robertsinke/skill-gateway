import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findActiveSkillCompletion,
  parseSkillSelection,
  replaceSkillSelection,
  skillCompletions,
  nativeSkillCommand,
} from "../src/picker-contract.ts";

describe("skill picker contract", () => {
  it("preserves ranked names and descriptions for native argument completions", () => {
    assert.deepEqual(skillCompletions([
      { name: "best-match", description: "First" },
      { name: "next-match", description: "Second" },
    ]), [
      { value: "best-match", label: "best-match", description: "First" },
      { value: "next-match", label: "next-match", description: "Second" },
    ]);
  });

  it("parses a standalone skill reference between existing prompt text", () => {
    const text = "Review this \\archify before sending";
    const selection = parseSkillSelection(text);
    assert.deepEqual(selection, { name: "archify", start: 12, end: 20 });
    assert.equal(nativeSkillCommand(text, selection!, "archify"), "/skill:archify Review this before sending");
  });

  it("ignores ordinary and escaped backslashes", () => {
    assert.equal(parseSkillSelection("ordinary message"), null);
    assert.equal(parseSkillSelection("path \\\\archify"), null);
  });

  it("recognizes a free backslash at the cursor anywhere, including an empty token with trailing spaces", () => {
    assert.deepEqual(findActiveSkillCompletion("Review \\arc later", 11), {
      start: 7,
      end: 11,
      replaceEnd: 11,
      prefix: "\\arc",
      query: "arc",
    });
    assert.deepEqual(findActiveSkillCompletion("one \\  two", 7), {
      start: 4,
      end: 5,
      replaceEnd: 5,
      prefix: "\\",
      query: "",
    });
    assert.equal(findActiveSkillCompletion("path\\arc", 8), null);
  });

  it("routes selected skills through Pi's native skill command and preserves the request", () => {
    const text = "Review this \\archify before sending";
    const selection = parseSkillSelection(text)!;
    assert.equal(nativeSkillCommand(text, selection, "archify"), "/skill:archify Review this before sending");
    assert.equal(nativeSkillCommand("\\archify show the new architecture", parseSkillSelection("\\archify show")!, "archify"), "/skill:archify show the new architecture");
    assert.equal(nativeSkillCommand("\\kw:plan", parseSkillSelection("\\kw:plan")!, "kw:plan"), null);
  });
});
