import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchdJobForServer } from "../bb-plugin/server-supervision.ts";

const ENTRY = "/Users/me/.local/share/skill-gateway/dist/serve.js";

function agents(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "sg-launchd-"));
  mkdirSync(directory, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  return directory;
}

function plist(label: string, args: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `<string>${arg}</string>`).join("")}</array>
</dict></plist>`;
}

test("finds the LaunchAgent that runs the configured entrypoint", () => {
  const directory = agents({
    "com.me.skill-gateway.server.plist": plist("com.me.skill-gateway.server", ["/opt/homebrew/bin/node", ENTRY]),
    "com.me.unrelated.plist": plist("com.me.unrelated", ["/usr/bin/true"]),
  });
  const job = launchdJobForServer(ENTRY, { directories: [directory] });
  assert.equal(job?.label, "com.me.skill-gateway.server");
});

test("a LaunchAgent for the MCP server does not count as supervising the dashboard", () => {
  const directory = agents({
    "com.me.skill-gateway.http-mcp.plist": plist("com.me.skill-gateway.http-mcp", [
      "/opt/homebrew/bin/node",
      "/Users/me/dev/skill-gateway/dist/http-mcp.js",
    ]),
  });
  assert.equal(launchdJobForServer(ENTRY, { directories: [directory] }), null);
});

test("ignores binary plists and missing directories", () => {
  const directory = agents({ "com.me.binary.plist": "bplist00\u0000binary" });
  assert.equal(launchdJobForServer(ENTRY, { directories: [directory, join(directory, "absent")] }), null);
});

test("falls back to the filename when the plist has no label", () => {
  const directory = agents({
    "com.me.serve.plist": `<plist><dict><key>ProgramArguments</key><array><string>node</string><string>${ENTRY}</string></array></dict></plist>`,
  });
  assert.equal(launchdJobForServer(ENTRY, { directories: [directory] })?.label, "com.me.serve");
});
