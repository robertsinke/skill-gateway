import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const text = readFileSync(fileURLToPath(new URL("../skills/gateway/SKILL.md", import.meta.url)), "utf8");
const [, front = "", body = ""] = text.split("---");
const description = front
  .split("\n")
  .find((line) => line.startsWith("description:"))
  ?.split(":")
  .slice(1)
  .join(":")
  .trim()
  .replaceAll('"', "")
  .replaceAll("'", "");

describe("gateway skill", () => {
  it("says to search before loading and to load nothing from an empty shortlist", () => {
    const lowered = (description ?? "").toLowerCase();
    assert.match(lowered, /shortlist/);
    assert.match(lowered, /user message/);
    assert.match(lowered, /load a library skill only from that list/);
    assert.match(body.toLowerCase(), /load no library skill/);
    assert.match(body.toLowerCase(), /empty/);
    assert.match(body.toLowerCase(), /fail/);
  });

  it("distinguishes a named skill from a quoted name and a workspace-map name", () => {
    assert.match(body, /--exact/);
    assert.match(body.toLowerCase(), /quoted/);
    assert.match(body.toLowerCase(), /workspace/);
  });

  it("uses the tighter cap only for a repeat search", () => {
    assert.match(body, /dist\/search\.js/);
    assert.equal(body.includes("search.py"), false);
    assert.match(body.toLowerCase(), /same user message/);
    assert.match(body, /--limit 10/);
    assert.match(body.toLowerCase(), /next user message/);
    assert.match(body, /20/);
  });
});
