import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { B, K1, type Document, exactLookup, rank, tokenize } from "../src/rank.ts";

function doc(name: string, description: string, directory: string): Document {
  return { name, description, path: directory };
}

describe("ranker", () => {
  it("keeps the Okapi defaults locked", () => {
    assert.equal(K1, 1.5);
    assert.equal(B, 0.75);
  });

  it("ranks an overlapping skill first and omits unrelated skills", () => {
    const documents = [
      doc("calendar", "schedule a meeting", "/lib/calendar"),
      doc("inbox", "read mail threads", "/lib/inbox"),
      doc("notes", "capture a thought", "/lib/notes"),
    ];
    const hits = rank("schedule the meeting", documents, 20);
    assert.deepEqual(
      hits.map((hit) => hit.document.name),
      ["calendar"],
    );
    assert.ok(hits[0] !== undefined && hits[0].score > 0);
  });

  it("lets a name hit beat a long weak description", () => {
    const filler = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const documents = [
      doc("calendar", "schedule a meeting", "/lib/calendar"),
      doc("inbox", `calendar ${filler}`, "/lib/inbox"),
    ];
    const hits = rank("calendar", documents, 20);
    assert.equal(hits[0]?.document.name, "calendar");
  });

  it("returns only positive hits when fewer than the cap match", () => {
    const documents = [
      doc("calendar", "schedule a meeting", "/lib/calendar"),
      doc("inbox", "read mail threads", "/lib/inbox"),
    ];
    const hits = rank("schedule the meeting", documents, 20);
    assert.equal(hits.length, 1);
  });

  it("returns an empty list when every score is zero", () => {
    const documents = [
      doc("calendar", "schedule a meeting", "/lib/calendar"),
      doc("inbox", "read mail threads", "/lib/inbox"),
    ];
    assert.deepEqual(rank("quantum ceramics", documents, 20), []);
  });

  it("sorts equal scores by name and repeats that order", () => {
    const documents = [
      doc("mango", "shared topic", "/lib/mango"),
      doc("apple", "shared topic", "/lib/apple"),
    ];
    const first = rank("shared topic", documents, 20).map((hit) => hit.document.name);
    const second = rank("shared topic", documents, 20).map((hit) => hit.document.name);
    assert.deepEqual(first, ["apple", "mango"]);
    assert.deepEqual(second, first);
  });

  it("treats URL-only and stopword-only queries as empty", () => {
    const documents = [doc("calendar", "schedule a meeting", "/lib/calendar")];
    assert.deepEqual(tokenize("https://example.com/tickets/ABC-123"), []);
    assert.deepEqual(tokenize("the and of"), []);
    assert.deepEqual(rank("https://example.com/a", documents, 20), []);
    assert.deepEqual(rank("the and of", documents, 20), []);
  });

  it("matches accents and plurals to the folded singular", () => {
    const documents = [doc("cafe-notes", "cafe skill for meetings", "/lib/cafe-notes")];
    const hits = rank("café skills", documents, 20);
    assert.deepEqual(
      hits.map((hit) => hit.document.name),
      ["cafe-notes"],
    );
  });

  it("looks up a frontmatter name and returns nothing for an unknown name", () => {
    const documents = [
      doc("kw:probe", "check a thing", "/lib/kw_probe"),
      doc("calendar", "schedule a meeting", "/lib/calendar"),
    ];
    const found = exactLookup("kw:probe", documents);
    assert.ok(found);
    assert.equal(found?.path, "/lib/kw_probe");
    assert.equal(exactLookup("missing-skill", documents), null);
  });

  it("looks up a directory basename", () => {
    const documents = [doc("kw:probe", "check a thing", "/lib/kw_probe")];
    const found = exactLookup("kw_probe", documents);
    assert.ok(found);
    assert.equal(found?.path, "/lib/kw_probe");
  });

  it("matches an empty description on the name", () => {
    const documents = [doc("widget", "", "/lib/widget")];
    const hits = rank("widget", documents, 20);
    assert.deepEqual(
      hits.map((hit) => hit.document.name),
      ["widget"],
    );
  });

  it("returns nothing when an exact lookup is ambiguous", () => {
    const documents = [
      doc("alpha", "one", "/lib/alpha"),
      doc("beta", "two", "/lib/alpha-copy"),
    ];
    const clash = [
      doc("shared", "one", "/lib/left"),
      doc("other", "two", "/lib/shared"),
    ];
    assert.equal(exactLookup("shared", clash), null);
    assert.ok(exactLookup("alpha", documents));
  });
});
