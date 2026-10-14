import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../extensions/skill-gateway.ts";
import { skillReadPrompt } from "../src/picker-contract.ts";

describe("Pi skill picker extension", () => {
  it("registers the gateway MCP server and a private-library keyboard shortcut", () => {
    const shortcuts = new Map<string, { description?: string }>();
    const servers: string[] = [];
    extension({
      registerMcpServer(name: string) { servers.push(name); },
      registerShortcut(name: string, options: { description?: string }) { shortcuts.set(name, options); },
      on() {},
    } as never);

    assert.deepEqual(servers, ["skill_gateway_picker"]);
    assert.match(shortcuts.get("\\")?.description ?? "", /private library skills/);
  });

  it("builds an exact-name read instruction without embedding a path", () => {
    const prompt = skillReadPrompt("kw:plan");
    assert.match(prompt, /skills_read_skill/);
    assert.match(prompt, /"kw:plan"/);
    assert.doesNotMatch(prompt, /\/Users\/|\.local\/share/);
  });
});
