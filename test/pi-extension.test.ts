import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../extensions/skill-gateway.ts";

describe("Pi skill picker extension", () => {
  it("registers the gateway MCP server and native /library argument completion", () => {
    const commands = new Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => Promise<unknown>; handler: (args: string, ctx: never) => Promise<void> }>();
    const servers: string[] = [];
    extension({
      registerMcpServer(name: string) { servers.push(name); },
      registerCommand(name: string, options: { description?: string; getArgumentCompletions?: (prefix: string) => Promise<unknown>; handler: (args: string, ctx: never) => Promise<void> }) {
        commands.set(name, options);
      },
      on() {},
    } as never);

    assert.deepEqual(servers, ["skill_gateway_picker"]);
    const command = commands.get("library");
    assert.ok(command?.getArgumentCompletions);
    assert.match(command.description ?? "", /private library skill/);
  });

  it("submits an exact-name read instruction immediately without embedding a path", async () => {
    let submitted = "";
    const command = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
    extension({
      registerMcpServer() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) { command.set(name, options); },
      sendUserMessage(message: string) { submitted = message; },
      on() {},
    } as never);

    await command.get("library")!.handler("kw:plan", {
      ui: { notify() {} },
    } as never);
    assert.match(submitted, /skills_read_skill/);
    assert.match(submitted, /"kw:plan"/);
    assert.doesNotMatch(submitted, /\/Users\/|\.local\/share/);
  });
});
