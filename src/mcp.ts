import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { rank } from "./rank.ts";
import { DEFAULT_ROOT, SearchError, defaultRoots, loadCatalog, loadMerged, lookup, lookupRoots } from "./search.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const SEARCH_UI_URI = "ui://skill-gateway/skill-search.html";

const INSTRUCTIONS =
  "Search this local skill library before reading a library skill that is not already loaded. " +
  "Pass the current user message as the query. Use skills_lookup_skill only when the user names a skill. " +
  "Use skills_read_skill to read the full SKILL.md after selecting one unambiguous result. " +
  "A quoted name, or a name that only appears in a workspace map, is a search, not a lookup. " +
  "An empty result means load no library skill and do not list the library.";

type Result = { name: string; path: string; description: string; score: number };
type Page = {
  total: number;
  count: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  results: Result[];
};

export function libraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.SKILL_GATEWAY_ROOT ?? "").trim();
  return override || DEFAULT_ROOT;
}

export function searchLibrary(
  query: string,
  options: { limit?: number; offset?: number; format?: "markdown" | "json"; root?: string } = {},
): string {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  const format = options.format ?? "markdown";
  try {
    const payload = page(query.trim(), limit, offset, options.root);
    return formatResults(payload, format, "Skill shortlist");
  } catch (error) {
    if (error instanceof SearchError) return missingLibrary(error);
    throw error;
  }
}

export function lookupSkill(name: string, options: { format?: "markdown" | "json"; root?: string } = {}): string {
  const format = options.format ?? "markdown";
  try {
    const found = find(name.trim(), options.root);
    const payload: Page = {
      total: found.length,
      count: found.length,
      offset: 0,
      limit: 1,
      has_more: false,
      next_offset: null,
      results: found,
    };
    return formatResults(payload, format, "Skill lookup");
  } catch (error) {
    if (error instanceof SearchError) return missingLibrary(error);
    throw error;
  }
}

export function readSkill(name: string, options: { format?: "markdown" | "json"; root?: string } = {}): string {
  const format = options.format ?? "markdown";
  try {
    const found = find(name.trim(), options.root);
    if (found.length !== 1) {
      return format === "json"
        ? JSON.stringify({ name, found: [] }, null, 2)
        : "# Skill read\n\nNo unambiguous skill matched.\n";
    }
    const skill = found[0]!;
    const content = readFileSync(join(skill.path, "SKILL.md"), "utf8");
    if (format === "json") return JSON.stringify({ ...skill, content }, null, 2);
    return `# ${skill.name}\n\n- **Path**: ${skill.path}\n\n${content}`;
  } catch (error) {
    if (error instanceof SearchError) return missingLibrary(error);
    throw error;
  }
}

function page(query: string, limit: number, offset: number, root?: string): Page {
  const documents = (root ? loadCatalog(root) : loadMerged(defaultRoots())).map((skill) => skill.document);
  const hits = rank(query, documents, Math.max(documents.length, 1));
  const slice = hits.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    total: hits.length,
    count: slice.length,
    offset,
    limit,
    has_more: next < hits.length,
    next_offset: next < hits.length ? next : null,
    results: slice.map((hit) => ({
      name: hit.document.name,
      path: hit.document.path,
      description: hit.document.description,
      score: hit.score,
    })),
  };
}

function find(name: string, root?: string): Result[] {
  return root ? lookup(root, name) : lookupRoots(defaultRoots(), name);
}

function formatResults(payload: Page, format: "markdown" | "json", heading: string): string {
  if (format === "json") return JSON.stringify(payload, null, 2);
  if (payload.results.length === 0) return `# ${heading}\n\nNo skills matched. Load no library skill.\n`;
  const lines = [`# ${heading}`, "", `Showing ${payload.count} of ${payload.total} (offset ${payload.offset}).`, ""];
  for (const item of payload.results) {
    lines.push(`## ${item.name}`, `- **Path**: ${item.path}`, `- **Description**: ${item.description.trim() || "(no description)"}`, "");
  }
  if (payload.has_more) lines.push(`More results start at offset ${payload.next_offset}.`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function missingLibrary(error: SearchError): string {
  return `Error: ${error.message}. The skill library directory is missing. Point SKILL_GATEWAY_ROOT at the directory whose children each contain a SKILL.md.`;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "skills_mcp", version: "1.0.0", title: "Skill library" }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerResource(
    "skill-search-ui",
    SEARCH_UI_URI,
    {
      title: "Skill Gateway search results",
      description: "Shows the skills returned by a private skill-library search.",
      mimeType: "text/html;profile=mcp-app",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: SEARCH_UI_HTML }],
    }),
  );
  server.registerTool(
    "skills_search_library",
    {
      title: "Search skill library",
      description: "Shortlist the local skill library by name and description.",
      inputSchema: {
        query: z.string().max(4000),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
        response_format: z.enum(["markdown", "json"]).optional(),
      },
      outputSchema: {
        status: z.literal("complete"),
        query: z.string(),
        count: z.number().int(),
        total: z.number().int(),
        results: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            description: z.string(),
            score: z.number(),
          }),
        ),
      },
      _meta: {
        ui: { resourceUri: SEARCH_UI_URI },
        "openai/outputTemplate": SEARCH_UI_URI,
      },
      annotations: { ...readOnly, title: "Search skill library" },
    },
    async ({ query, limit, offset, response_format }) => {
      const payload = page(query.trim(), limit ?? DEFAULT_LIMIT, offset ?? 0);
      return {
        content: [{ type: "text", text: formatResults(payload, response_format ?? "markdown", "Skill shortlist") }],
        structuredContent: {
          status: "complete" as const,
          query: query.trim(),
          count: payload.count,
          total: payload.total,
          results: payload.results,
        },
      };
    },
  );
  server.registerTool(
    "skills_lookup_skill",
    {
      title: "Look up a named skill",
      description: "Return one skill when the user names it.",
      inputSchema: {
        name: z.string().min(1).max(200),
        response_format: z.enum(["markdown", "json"]).optional(),
      },
      annotations: { ...readOnly, title: "Look up a named skill" },
    },
    async ({ name, response_format }) => ({
      content: [{ type: "text", text: lookupSkill(name, { format: response_format }) }],
    }),
  );
  server.registerTool(
    "skills_read_skill",
    {
      title: "Read a named skill",
      description: "Return the full SKILL.md for one unambiguous skill name from the private library.",
      inputSchema: {
        name: z.string().min(1).max(200),
        response_format: z.enum(["markdown", "json"]).optional(),
      },
      annotations: { ...readOnly, title: "Read a named skill" },
    },
    async ({ name, response_format }) => ({
      content: [{ type: "text", text: readSkill(name, { format: response_format }) }],
    }),
  );
  return server;
}

const SEARCH_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Skill Gateway</title>
    <style>
      :root { color-scheme: light dark; font: 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      body { margin: 0; padding: 16px; color: #242424; background: #fff; }
      @media (prefers-color-scheme: dark) { body { color: #eee; background: #202020; } .card { border-color: #444; } .muted { color: #aaa; } }
      .header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #22a06b; box-shadow: 0 0 0 3px #22a06b22; }
      h1 { font-size: 15px; margin: 0; } .muted { color: #777; }
      .query { margin-bottom: 12px; color: #555; } @media (prefers-color-scheme: dark) { .query { color: #bbb; } }
      .card { border: 1px solid #e2e2e2; border-radius: 10px; padding: 11px 12px; margin: 8px 0; }
      .name { font-weight: 650; } .score { float: right; color: #777; font-variant-numeric: tabular-nums; }
      .description { margin-top: 4px; } .path { margin-top: 6px; font-size: 12px; color: #777; overflow-wrap: anywhere; }
      .empty { padding: 12px 0; color: #777; }
    </style>
  </head>
  <body>
    <div id="app"><div class="header"><span class="dot"></span><h1>Skill Gateway</h1></div><div class="muted">Waiting for search results…</div></div>
    <script>
      const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      const render = (data) => {
        const results = Array.isArray(data?.results) ? data.results : [];
        const count = Number.isFinite(data?.count) ? data.count : results.length;
        const total = Number.isFinite(data?.total) ? data.total : results.length;
        const cards = results.map((item) => '<div class="card"><span class="name">' + escapeHtml(item.name) + '</span><span class="score">' + escapeHtml(Number(item.score ?? 0).toFixed(2)) + '</span><div class="description">' + escapeHtml(item.description || 'No description') + '</div><div class="path">' + escapeHtml(item.path) + '</div></div>').join('');
        document.querySelector('#app').innerHTML = '<div class="header"><span class="dot"></span><h1>Skill Gateway</h1><span class="muted">returned</span></div><div class="query">' + escapeHtml(data?.query || 'Skill search') + ' · ' + count + ' of ' + total + ' returned</div>' + (cards || '<div class="empty">No matching skills.</div>');
      };
      const openai = window.openai;
      if (openai?.toolOutput) render(openai.toolOutput);
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
        if (event.data.method === 'ui/notifications/tool-result') render(event.data.params?.structuredContent || event.data.params);
      });
    </script>
  </body>
</html>`;

if (basename(process.argv[1] ?? "") === "mcp.ts" || basename(process.argv[1] ?? "") === "mcp.js") {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
