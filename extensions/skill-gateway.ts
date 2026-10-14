import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillCompletions, skillReadPrompt } from "../src/picker-contract.ts";

type SuggestionPayload = {
  results: { name: string; description: string }[];
};

const endpoint = process.env.SKILL_GATEWAY_MCP_URL || "http://127.0.0.1:8742/mcp";

function parseSuggestions(result: unknown): SuggestionPayload {
  if (!result || typeof result !== "object") throw new Error("gateway returned an invalid suggestion response");
  const response = result as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  if (response.isError) {
    const details = Array.isArray(response.content)
      ? response.content.map((item: unknown) => item && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n")
      : "";
    throw new Error(details || "gateway rejected skill suggestions");
  }
  const data = response.structuredContent as Partial<SuggestionPayload> | undefined;
  if (!data || !Array.isArray(data.results)) throw new Error("gateway returned an invalid suggestion response");
  const results = data.results.filter((item): item is { name: string; description: string } =>
    Boolean(item) && typeof item.name === "string" && typeof item.description === "string",
  );
  return { results };
}

function failureMessage(error: unknown): string {
  const details = error instanceof Error ? error.message : String(error);
  return `Skill Gateway unavailable at ${endpoint}: ${details}`;
}

export default function (pi: ExtensionAPI): void {
  pi.registerMcpServer("skill_gateway_picker", { url: endpoint, timeout: 5_000 });

  let clientPromise: Promise<Client> | undefined;
  let notify: ((message: string) => void) | undefined;
  let failureShown = false;

  const getClient = (): Promise<Client> => {
    clientPromise ??= (async () => {
      const client = new Client({ name: "skill-gateway-pi-picker", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(endpoint));
      await client.connect(transport);
      return client;
    })();
    return clientPromise;
  };

  const showFailure = (error: unknown): void => {
    if (failureShown) return;
    failureShown = true;
    notify?.(failureMessage(error));
  };

  pi.on("session_start", (_event, ctx) => {
    failureShown = false;
    notify = ctx.hasUI ? (message) => ctx.ui.notify(message, "error") : undefined;
    void getClient().catch(showFailure);
  });

  pi.registerCommand("library", {
    description: "Find and read a private library skill",
    getArgumentCompletions: async (argumentPrefix) => {
      const query = argumentPrefix.trim();
      if (query.length > 4_000) {
        showFailure(new Error("search query exceeds 4000 characters"));
        return null;
      }
      try {
        const client = await getClient();
        const result = await client.callTool({
          name: "skills_suggest_library",
          arguments: { query, limit: 20 },
        });
        return skillCompletions(parseSuggestions(result).results);
      } catch (error) {
        showFailure(error);
        return null;
      }
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /library <library skill name>", "warning");
        return;
      }
      if (name.length > 200) {
        ctx.ui.notify("Skill names must be 200 characters or fewer.", "error");
        return;
      }
      pi.sendUserMessage(skillReadPrompt(name));
    },
  });
}
