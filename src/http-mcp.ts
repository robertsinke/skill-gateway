import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "./mcp.ts";

export const HOST = "127.0.0.1";
export const PORT = 8742;
export const MCP_PATH = "/mcp";

type Session = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
};

export function createHttpMcpServer(
  host = process.env.SKILL_GATEWAY_MCP_HOST || HOST,
  port = Number(process.env.SKILL_GATEWAY_MCP_PORT || PORT),
) {
  const sessions = new Map<string, Session>();
  const expectedToken = (process.env.SKILL_GATEWAY_MCP_TOKEN ?? "").trim();

  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET") {
        send(response, 200, "ok\n", "text/plain; charset=utf-8");
        return;
      }
      if (new URL(request.url ?? "/", `http://${host}`).pathname !== MCP_PATH) {
        send(response, 404, "not found\n", "text/plain; charset=utf-8");
        return;
      }
      if (!authorized(request, expectedToken)) {
        send(response, 401, "unauthorized\n", "text/plain; charset=utf-8", { "www-authenticate": "Bearer" });
        return;
      }

      const sessionId = header(request, "mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session && request.method === "POST" && !sessionId) {
        session = await newSession(sessions);
      }
      if (!session) {
        send(response, 400, "missing or unknown mcp-session-id\n", "text/plain; charset=utf-8");
        return;
      }
      await session.transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        send(response, 500, `${error instanceof Error ? error.message : "internal error"}\n`, "text/plain; charset=utf-8");
      } else {
        response.end();
      }
    }
  });

  return { server, host, port };

  async function newSession(store: Map<string, Session>): Promise<Session> {
    let session!: Session;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        store.set(id, session);
      },
    });
    const mcp = createMcpServer();
    session = { server: mcp, transport };
    transport.onclose = () => {
      if (transport.sessionId) store.delete(transport.sessionId);
      void mcp.close();
    };
    await mcp.connect(transport);
    return session;
  }
}

export function startHttpMcpServer(
  host = process.env.SKILL_GATEWAY_MCP_HOST || HOST,
  port = Number(process.env.SKILL_GATEWAY_MCP_PORT || PORT),
) {
  const app = createHttpMcpServer(host, port);
  app.server.listen(app.port, app.host, () => {
    console.error(`skill-gateway MCP listening at http://${app.host}:${app.port}${MCP_PATH}`);
  });
  return app.server;
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) return true;
  return header(request, "authorization") === `Bearer ${expectedToken}`;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  type: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": type, ...headers });
  response.end(body);
}

if (basename(process.argv[1] ?? "") === "http-mcp.ts" || basename(process.argv[1] ?? "") === "http-mcp.js") {
  startHttpMcpServer();
}
