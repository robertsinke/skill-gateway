import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { start } from "../src/serve.ts";

function skill(root: string): void {
  const folder = join(root, "calendar");
  mkdirSync(folder);
  writeFileSync(
    folder + "/SKILL.md",
    `---
name: calendar
description: schedule a meeting
targets:
  - please schedule the quarterly offsite
  - book a meeting tomorrow
  - put time on the calendar
---
`,
    "utf8",
  );
}

async function listen(): Promise<{ server: Server; origin: string }> {
  const server = await start("127.0.0.1", 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe("localhost page", () => {
  it("serves the page, inventory, and preview on loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "serve-"));
    skill(root);
    process.env.SKILL_GATEWAY_ROOT = root;
    process.env.SKILL_GATEWAY_LOG = "-";
    const { server, origin } = await listen();
    try {
      const page = await fetch(`${origin}/`);
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.match(body, /Skills/);
      assert.match(body, /Router/);
      assert.match(body, /Analytics/);
      assert.match(body, /Search skills/);
      assert.match(body, /Scan this machine/);
      const inventory = await (await fetch(`${origin}/api/skills`)).json();
      assert.equal(inventory.skills[0].name, "calendar");
      assert.ok("location" in inventory.skills[0]);
      assert.equal(inventory.skills[0].uses, 0);
      assert.equal(inventory.queries, 0);
      const report = await (
        await fetch(`${origin}/api/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "calendar", description: "schedule a meeting" }),
        })
      ).json();
      assert.equal(report.name, "calendar");
      assert.equal(report.rows.length, 3);
      const weak = await (
        await fetch(`${origin}/api/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "calendar", description: "" }),
        })
      ).json();
      assert.notEqual(weak.green, report.green);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.SKILL_GATEWAY_ROOT;
      delete process.env.SKILL_GATEWAY_LOG;
    }
  });

  it("returns 404 for an unknown path and 400 for a bad preview", async () => {
    const { server, origin } = await listen();
    try {
      assert.equal((await fetch(`${origin}/missing`)).status, 404);
      const missingName = await fetch(`${origin}/api/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "schedule a meeting" }),
      });
      assert.equal(missingName.status, 400);
      const badJson = await fetch(`${origin}/api/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(badJson.status, 400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
