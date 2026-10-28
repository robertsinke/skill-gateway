// bb-plugin-skill-gateway — the skill-selection decision lives in BB.
//
// A host adapter (today: the Pi extension) suppresses its provider's native
// skill roster, then posts one user message here. This plugin runs the
// Skill Gateway entrypoint, which searches the library locally and asks Jev for
// one skill or none, and returns only that skill's instructions. The adapter
// injects them; nothing about the library reaches the model otherwise.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MAX_PROMPT_CHARS = 32_000;
const MAX_LOADED = 64;
const SELECT_TIMEOUT_MS = 10_000;

/**
 * Runs inside the dashboard frame. The host posts its theme tokens; this maps
 * them onto the dashboard's own variables so the panel follows the app theme.
 */
const THEME_BRIDGE = `
globalThis.__SKILL_GATEWAY_PROXY__="/api/v1/plugins/skill-gateway/http/api";
addEventListener("message",function(event){var data=event.data;if(!data||data.type!=="skill-gateway-theme")return;
var tokens=data.tokens||{},root=document.documentElement.style;
root.setProperty("color-scheme",data.dark?"dark":"light");
var map={paper:"--canvas",sidebar:"--canvas",ink:"--ink",body:"--ink",secondary:"--muted-foreground",muted:"--subtle-foreground",line:"--border",active:"--accent",font:"--font-sans"};
for(var name in map){var value=tokens[map[name]];if(value)root.setProperty("--"+name,value);}});
`;

const requestSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  sessionId: z.string().min(1).max(200),
  cwd: z.string().max(4096).optional(),
  root: z.string().max(4096).optional(),
});

const answerSchema = z.object({
  name: z.string().nullable(),
  context: z.string(),
  reason: z.string(),
  inline: z.boolean(),
  latency_ms: z.number(),
  candidates: z.array(z.string()),
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    gatewayEntry: {
      type: "string",
      label: "Skill Gateway select entrypoint",
      description: "select.js from the Skill Gateway build. Must exist on the BB server machine.",
      default: join(homedir(), ".local", "share", "skill-gateway", "dist", "select.js"),
    },
    libraryRoot: {
      type: "string",
      label: "Skill library root",
      description: "Directory whose children each contain SKILL.md. Empty uses the gateway's standard roots.",
      default: "",
    },
    nodeBinary: { type: "string", label: "Node binary", default: "node" },
    uiDir: {
      type: "string",
      label: "Dashboard build directory",
      description: "The SKILL_GATEWAY_UI_BASE build of src/ui, served under /ui.",
      default: join(homedir(), "dev", "skill-gateway", "dist", "ui-bb"),
    },
    gatewayServerUrl: {
      type: "string",
      label: "Gateway server URL",
      description: "Where the dashboard's /api calls are relayed.",
      default: "http://127.0.0.1:8741",
    },
  });

  const loadedKey = (sessionId: string) => `loaded:${sessionId}`;

  async function loadedFor(sessionId: string): Promise<string[]> {
    const names = await bb.storage.kv.get<string[]>(loadedKey(sessionId));
    return Array.isArray(names) ? names : [];
  }

  async function remember(sessionId: string, name: string): Promise<void> {
    const names = await loadedFor(sessionId);
    if (names.includes(name)) return;
    await bb.storage.kv.set(loadedKey(sessionId), [...names, name].slice(-MAX_LOADED));
  }

  type Answer = z.infer<typeof answerSchema>;

  async function select(
    request: z.infer<typeof requestSchema>,
  ): Promise<{ ok: true; answer: Answer } | { ok: false; message: string }> {
    const { gatewayEntry, libraryRoot, nodeBinary } = await settings.get();
    const payload = JSON.stringify({
      prompt: request.prompt,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...((request.root ?? libraryRoot) ? { root: request.root ?? libraryRoot } : {}),
      loaded: await loadedFor(request.sessionId),
    });
    try {
      const stdout = await run(nodeBinary, [gatewayEntry], payload);
      const parsed = answerSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) return { ok: false, message: "select entrypoint returned an unexpected shape" };
      if (parsed.data.name && parsed.data.inline) await remember(request.sessionId, parsed.data.name);
      return { ok: true, answer: parsed.data };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "select failed" };
    }
  }

  function run(command: string, args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { timeout: SELECT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, cwd: homedir() },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout.trim());
        },
      );
      child.stdin?.end(input);
    });
  }

  // The host adapter's only entry: one message in, one skill's instructions out.
  bb.http.route(
    "POST",
    "/select",
    async (context) => {
      const body = await context.req.json().catch(() => null);
      const request = requestSchema.safeParse(body);
      if (!request.success) {
        return context.json({ ok: false, error: "invalid_request", issues: request.error.issues }, 422);
      }
      const result = await select(request.data);
      if (!result.ok) return context.json({ ok: false, error: "select_failed", message: result.message }, 502);
      return context.json({ ok: true, ...result.answer });
    },
    { auth: "token" },
  );

  bb.http.route(
    "GET",
    "/status",
    async (context) => {
      const { gatewayEntry, libraryRoot } = await settings.get();
      return context.json({ ok: true, gatewayEntry, libraryRoot: libraryRoot || null });
    },
    { auth: "token" },
  );

    // The dashboard is the existing Svelte build, served same-origin so its
  // relative asset paths and /api relay work inside BB's panel.
  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
  };

  async function dashboardFile(relativePath: string, root: string): Promise<Response | null> {
    if (relativePath.includes("..")) return null;
    try {
      const bytes = readFileSync(join(root, relativePath));
      const type = CONTENT_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";
      if (relativePath !== "index.html") return new Response(bytes, { headers: { "content-type": type } });
      const html = bytes.toString("utf8").replace("</head>", `<script>${THEME_BRIDGE}</script></head>`);
      return new Response(html, { headers: { "content-type": type } });
    } catch {
      return null;
    }
  }

  // The dashboard's files are registered explicitly: the router has no wildcards.
  // Settings are read once per load, so routes exist before the factory returns.
  const { uiDir } = await settings.get();
  const dashboardRoot = uiDir.replace(/\/+$/, "");
  for (const relativePath of listFiles(dashboardRoot)) {
    bb.http.route(
      "GET",
      `/ui/${relativePath}`,
      async () => (await dashboardFile(relativePath, dashboardRoot)) ?? new Response("not found", { status: 404 }),
      { auth: "local" },
    );
  }

  // One relay path keeps the dashboard's many endpoints out of this plugin.
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    bb.http.route(
      method,
      "/api",
      async (context) => {
        const path = context.req.query("path") ?? "";
        if (!path.startsWith("/api/") || path.includes("..")) {
          return context.json({ error: "invalid_path" }, 400);
        }
        const { gatewayServerUrl } = await settings.get();
        const base = gatewayServerUrl.replace(/\/+$/, "");
        const body = method === "GET" || method === "DELETE" ? undefined : await context.req.arrayBuffer();
        try {
          const upstream = await fetch(`${base}${path}`, {
            method,
            ...(body ? { body, headers: { "content-type": context.req.header("content-type") ?? "application/json" } } : {}),
            signal: AbortSignal.timeout(15_000),
          });
          const bytes = await upstream.arrayBuffer();
          return new Response(bytes, {
            status: upstream.status,
            headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
          });
        } catch (error) {
          return context.json({ error: "gateway_unreachable", message: errorMessage(error), base }, 503);
        }
      },
      { auth: "local" },
    );
  }

  bb.cli.register({
    name: "skill-gateway",
    summary: "Skill gateway selection: status and one-off select",
    commands: [
      { name: "status", summary: "Show the configured select entrypoint and library root", usage: "bb skill-gateway status [--json]" },
      {
        name: "select",
        summary: "Select one skill for a prompt (JSON on stdin)",
        usage: 'bb skill-gateway select [--json] \'{"prompt":"…","sessionId":"…"}\'',
      },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const [command, ...rest] = argv.filter((arg) => arg !== "--json");
      const { gatewayEntry, libraryRoot } = await settings.get();
      if (command === undefined || command === "help" || command === "--help") {
        return {
          exitCode: 0,
          stdout: [
            "Usage:",
            "  bb skill-gateway status [--json]",
            '  bb skill-gateway select [--json] \'{"prompt":"…","sessionId":"…"}\'',
          ].join("\n"),
        };
      }
      if (command === "status") {
        const value = { gatewayEntry, libraryRoot: libraryRoot || null };
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(value) : `entrypoint: ${value.gatewayEntry}\nlibrary: ${value.libraryRoot ?? "(gateway default)"}`,
        };
      }
      if (command === "select") {
        const payload = rest.length > 0 ? rest.join(" ") : await readStdin();
        const request = requestSchema.safeParse(parseJson(payload));
        if (!request.success) return { exitCode: 2, stderr: "expected {\"prompt\":string,\"sessionId\":string}" };
        const result = await select(request.data);
        if (!result.ok) return { exitCode: 1, stderr: result.message };
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(result.answer)
            : `${result.answer.name ?? "(none)"} — ${result.answer.reason} (${result.answer.latency_ms}ms; session ${context.threadId ?? "n/a"})`,
        };
      }
      return { exitCode: 1, stderr: "unknown command; run `bb skill-gateway status`" };
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every file under the dashboard build, as `/`-joined relative paths. */
function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return files;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
