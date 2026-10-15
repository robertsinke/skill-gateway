import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension, { applyBackslashCompletion, fixedHeightAutocompleteItems } from "../extensions/skill-gateway.ts";
import { skillReadPrompt } from "../src/picker-contract.ts";

describe("Pi skill picker extension", () => {
  it("registers live backslash autocomplete and input dispatch", () => {
    const events: string[] = [];
    const servers: string[] = [];
    extension({
      registerMcpServer(name: string) { servers.push(name); },
      on(event: string) { events.push(event); },
    } as never);

    assert.deepEqual(servers, ["skill_gateway_picker"]);
    assert.deepEqual(events.sort(), ["input", "session_start"]);
  });

  it("adds one space after a selected skill and preserves existing suffix text", () => {
    const selected = applyBackslashCompletion(["\\arc"], 0, 4, { value: "\\archify" }, "\\arc");
    assert.deepEqual(selected, { lines: ["\\archify "], cursorLine: 0, cursorCol: 9 });

    const existingSpace = applyBackslashCompletion(["\\arc more"], 0, 4, { value: "\\archify" }, "\\arc");
    assert.deepEqual(existingSpace, { lines: ["\\archify more"], cursorLine: 0, cursorCol: 9 });

    const adjacentSuffix = applyBackslashCompletion(["\\arcmore"], 0, 4, { value: "\\archify" }, "\\arc");
    assert.deepEqual(adjacentSuffix, { lines: ["\\archify more"], cursorLine: 0, cursorCol: 9 });
  });

  it("keeps the autocomplete panel at a fixed item count", () => {
    const oneMatch = fixedHeightAutocompleteItems([{ value: "\\kw:confidence", label: "kw:confidence" }]);
    const noMatches = fixedHeightAutocompleteItems([]);
    assert.equal(oneMatch.length, 20);
    assert.equal(noMatches.length, 20);
    assert.equal(oneMatch[0]?.label, "kw:confidence");
    assert.equal(noMatches[0]?.label, "No matching skills");
    assert.ok(oneMatch.slice(1).every(({ value }) => value.startsWith("__skill_gateway_padding__")));
  });

  it("builds an exact-name read instruction without embedding a path", () => {
    const prompt = skillReadPrompt("kw:plan");
    assert.match(prompt, /skills_read_skill/);
    assert.match(prompt, /"kw:plan"/);
    assert.doesNotMatch(prompt, /\/Users\/|\.local\/share/);
  });
});
