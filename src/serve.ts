import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview, saveTargets } from "./check.ts";
import { logPath, readRecent, suggestMessages } from "./query-log.ts";
import { DEFAULT_LOG } from "./query-log.ts";
import { gather, gatherPlace, listPlaces, removeCopies } from "./scan.ts";
import { DEFAULT_ROOT, SearchError, defaultRoots, loadCatalog, loadMerged } from "./search.ts";
import { loadIndex } from "./sources.ts";

export const HOST = "127.0.0.1";
export const PORT = 8741;

const assetTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

function uiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "ui"), join(here, "..", "dist", "ui")]) {
    if (existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets"))) return candidate;
  }
  throw new Error("UI build is missing. Run npm run build:ui.");
}

function pageHtml(): string {
  return readFileSync(join(uiRoot(), "index.html"), "utf8");
}

function staticFile(pathname: string): { body: Buffer; type: string } | null {
  if (!pathname.startsWith("/assets/")) return null;
  const root = resolve(uiRoot());
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}/`) || !existsSync(file) || !statSync(file).isFile()) return null;
  return { body: readFileSync(file), type: assetTypes[extname(file)] ?? "application/octet-stream" };
}

export function libraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.SKILL_GATEWAY_ROOT ?? "").trim();
  return override || DEFAULT_ROOT;
}

function activeCatalog(env: NodeJS.ProcessEnv = process.env) {
  const override = (env.SKILL_GATEWAY_ROOT ?? "").trim();
  if (override) return loadCatalog(override);
  return loadMerged(defaultRoots());
}

function opensToolServer(skill: { document: { description: string; path: string } }): boolean {
  if (skill.document.description.toLowerCase().includes("mcp")) return true;
  try {
    return readFileSync(join(skill.document.path, "SKILL.md"), "utf8").toLowerCase().includes("mcp");
  } catch {
    return false;
  }
}

function added(path: string): { added: string; addedAt: number } {
  try {
    const stamp = statSync(join(path, "SKILL.md")).mtimeMs / 1000;
    const moment = new Date(stamp * 1000);
    const month = moment.toLocaleString("en", { month: "short" });
    return { added: `${moment.getDate()} ${month}`, addedAt: stamp };
  } catch {
    return { added: "", addedAt: 0 };
  }
}

function location(path: string, origin: { owner?: string; source?: string }): string {
  const owner = (origin.owner ?? "").trim();
  if (owner) return owner;
  const source = (origin.source ?? "").trim();
  if (source) return source;
  const folder = resolve(path, "..");
  const home = homedir();
  const rel = relative(home, folder);
  if (rel.startsWith("..")) return basename(folder);
  return rel;
}

function logStats(env: NodeJS.ProcessEnv = process.env): { uses: Record<string, number>; queries: number; sessions: number } {
  const path = logPath(env);
  const uses: Record<string, number> = {};
  const sessions = new Set<string>();
  let queries = 0;
  if (path && existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let item: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        item = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      queries += 1;
      if (typeof item.session_id === "string" && item.session_id.trim()) sessions.add(item.session_id.trim());
      if (Array.isArray(item.skills)) {
        for (const name of item.skills) {
          if (typeof name === "string" && name) uses[name] = (uses[name] ?? 0) + 1;
        }
      }
    }
  }
  return { uses, queries, sessions: sessions.size };
}

export function inventory(env: NodeJS.ProcessEnv = process.env) {
  const index = loadIndex();
  const stats = logStats(env);
  const skills = activeCatalog(env).map((skill) => {
    const origin = index[skill.document.name] ?? { source: "", owner: "" };
    const toolServer = opensToolServer(skill);
    const when = added(skill.document.path);
    return {
      name: skill.document.name,
      description: skill.document.description,
      targets: [...skill.targets],
      opensToolServer: toolServer,
      source: origin.source,
      owner: origin.owner,
      location: location(skill.document.path, origin),
      added: when.added,
      addedAt: when.addedAt,
      uses: stats.uses[skill.document.name] ?? 0,
      status: toolServer ? "Tool server" : "",
    };
  });
  return { skills, queries: stats.queries, sessions: stats.sessions };
}

function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  const payload = typeof body === "string" ? Buffer.from(body) : body;
  response.writeHead(status, { "content-type": contentType, "content-length": payload.length });
  response.end(payload);
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  send(response, status, JSON.stringify(payload), "application/json");
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function start(host = HOST, port = PORT) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        send(response, 200, pageHtml(), "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET") {
        const file = staticFile(url.pathname);
        if (file) {
          send(response, 200, file.body, file.type);
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/skills") {
        sendJson(response, inventory());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/suggest") {
        const name = url.searchParams.get("name") ?? "";
        const logFile = logPath();
        const rows = logFile ? readRecent(logFile, 5000) : [];
        sendJson(response, { name, messages: suggestMessages(rows, name) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/queries") {
        sendJson(response, readRecent(logPath() ?? DEFAULT_LOG));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/scan/places") {
        sendJson(response, listPlaces());
        return;
      }
      if (request.method === "POST") {
        const body = await readBody(request);
        if (url.pathname === "/api/preview") {
          const name = String(body.name ?? "").trim();
          const description = String(body.description ?? "");
          const rawTargets = body.targets;
          if (!name) throw new SearchError("name is required");
          const catalog = activeCatalog();
          const report = preview(
            libraryRoot(),
            name,
            description,
            Array.isArray(rawTargets) ? rawTargets.map((item) => String(item)) : null,
            catalog,
          );
          sendJson(response, report);
          return;
        }
        if (url.pathname === "/api/targets") {
          const name = String(body.name ?? "").trim();
          const rawTargets = body.targets;
          if (!name || !Array.isArray(rawTargets)) throw new SearchError("name and three messages are required");
          const saved = saveTargets(libraryRoot(), name, rawTargets.map((item) => String(item)), activeCatalog());
          sendJson(response, { name, targets: saved });
          return;
        }
        if (url.pathname === "/api/scan") {
          const relativePath = String(body.relative ?? "").trim();
          sendJson(response, relativePath ? gatherPlace(relativePath) : gather());
          return;
        }
        if (url.pathname === "/api/scan/remove") {
          const raw = body.paths;
          const paths = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
          sendJson(response, removeCopies(paths));
          return;
        }
      }
      send(response, 404, "not found", "text/plain; charset=utf-8");
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof SearchError) {
        sendJson(response, { error: error.message }, 400);
        return;
      }
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  return new Promise<ReturnType<typeof createServer>>((resolveReady) => {
    server.listen(port, host, () => resolveReady(server));
  });
}

if (basename(process.argv[1] ?? "") === "serve.ts" || basename(process.argv[1] ?? "") === "serve.js") {
  const server = await start();
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : PORT;
  console.log(`skill gateway at http://${HOST}:${port}`);
}
