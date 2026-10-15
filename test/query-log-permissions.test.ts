import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { logPath, noteFollowup, record } from "../src/query-log.ts";

describe("query log permissions", () => {
  it("keeps prompt-bearing JSONL private across append and rewrite", () => {
    const directory = mkdtempSync(join(tmpdir(), "query-log-private-"));
    try {
      const env = { SKILL_GATEWAY_LOG: join(directory, "queries.jsonl") };
      const path = logPath(env)!;
      record({ session_id: "session" }, "private query", ["calendar"], env);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      noteFollowup("session", "thanks", env);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
