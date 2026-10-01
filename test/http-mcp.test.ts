import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHttpMcpServer } from "../src/http-mcp.ts";

describe("HTTP MCP server", () => {
  it("serves health and initializes an MCP session", async () => {
    const app = createHttpMcpServer("127.0.0.1", 0);
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");

    const initialize = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    assert.equal(initialize.status, 200);
    assert.ok(initialize.headers.get("mcp-session-id"));
    assert.match(await initialize.text(), /skills_mcp/);

    await new Promise<void>((resolve, reject) => app.server.close((error) => (error ? reject(error) : resolve())));
  });
});
