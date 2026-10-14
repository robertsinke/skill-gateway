import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpMcpServer } from "../src/http-mcp.ts";

function createSkill(root: string, name: string, description: string, body: string): void {
  const folder = join(root, name);
  mkdirSync(folder);
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
}

describe("HTTP picker contract", () => {
  it("returns minimal ranked metadata and reads the exact selected skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "picker-http-library-"));
    createSkill(root, "calendar", "schedule a meeting", "PRIVATE SKILL BODY");
    createSkill(root, "inbox", "read mail threads", "INBOX BODY");
    const previousRoot = process.env.SKILL_GATEWAY_ROOT;
    process.env.SKILL_GATEWAY_ROOT = root;
    const app = createHttpMcpServer("127.0.0.1", 0);
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");

    const client = new Client({ name: "picker-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "skills_suggest_library", arguments: { query: "schedule meeting" } });
      assert.equal(result.isError, undefined);
      const payload = result.structuredContent as { results: { name: string; description: string; path?: string }[] };
      assert.deepEqual(payload.results, [{ name: "calendar", description: "schedule a meeting" }]);
      assert.equal("path" in payload.results[0]!, false);
      assert.equal(JSON.stringify(payload).includes("PRIVATE SKILL BODY"), false);

      const selected = await client.callTool({ name: "skills_read_skill", arguments: { name: "calendar" } });
      assert.match(selected.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /PRIVATE SKILL BODY/);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
      if (previousRoot === undefined) delete process.env.SKILL_GATEWAY_ROOT;
      else process.env.SKILL_GATEWAY_ROOT = previousRoot;
    }
  });
});
