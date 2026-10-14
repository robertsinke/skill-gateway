import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillCompletions, skillReadPrompt } from "../src/picker-contract.ts";

type SuggestionPayload = {
  results: { name: string; description: string }[];
};

const endpoint = process.env.SKILL_GATEWAY_MCP_URL || "http://127.0.0.1:8742/mcp";
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/g;
const autocompleteItemCount = 20;
const nonSelectablePrefix = "__skill_gateway_padding__";

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

export function fixedHeightAutocompleteItems(items: { value: string; label: string; description?: string }[]) {
  const result = items.slice(0, autocompleteItemCount);
  if (result.length === 0) {
    result.push({ value: `${nonSelectablePrefix}empty`, label: "No matching skills" });
  }
  while (result.length < autocompleteItemCount) {
    result.push({ value: `${nonSelectablePrefix}${result.length}`, label: " " });
  }
  return result;
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

  const suggest = async (query: string, signal?: AbortSignal): Promise<SuggestionPayload["results"]> => {
    const client = await getClient();
    const result = await client.callTool({
      name: "skills_suggest_library",
      arguments: { query, limit: autocompleteItemCount },
    }, undefined, { signal, timeout: 5_000 });
    return parseSuggestions(result).results;
  };

  pi.on("session_start", (_event, ctx) => {
    failureShown = false;
    notify = ctx.hasUI ? (message) => ctx.ui.notify(message, "error") : undefined;
    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider((current) => ({
        triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "\\"])],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
          const start = beforeCursor.search(/\S/);
          if (start < 0 || beforeCursor[start] !== "\\") {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

          const prefix = beforeCursor.slice(start);
          const query = prefix.slice(1).trim();
          if (query.length > 4_000) return null;

          try {
            const suggestions = await suggest(query, options.signal);
            if (options.signal.aborted) return null;
            const items = skillCompletions(suggestions).map((item) => ({
              ...item,
              value: `\\${item.value}`,
              label: item.label.replace(controlCharacters, " "),
              description: item.description?.replace(controlCharacters, " "),
            }));
            return { items: fixedHeightAutocompleteItems(items), prefix };
          } catch (error) {
            if (!options.signal.aborted) ctx.ui.notify(failureMessage(error), "error");
            return null;
          }
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          if (item.value.startsWith(nonSelectablePrefix)) {
            return { lines, cursorLine, cursorCol };
          }
          if (!prefix.startsWith("\\")) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
          }
          const line = lines[cursorLine] ?? "";
          const prefixStart = cursorCol - prefix.length;
          const newLines = [...lines];
          newLines[cursorLine] = `${line.slice(0, prefixStart)}${item.value}${line.slice(cursorCol)}`;
          return {
            lines: newLines,
            cursorLine,
            cursorCol: prefixStart + item.value.length,
          };
        },
        shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
          ? (lines, cursorLine, cursorCol) => current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol)
          : undefined,
      }));
    }
    void getClient().catch(showFailure);
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text.trimStart();
    if (!text.startsWith("\\")) return { action: "continue" };

    const query = text.slice(1).trim();
    if (!query) {
      if (ctx.hasUI) ctx.ui.notify("Type after \\\\ and choose a skill suggestion.", "warning");
      return { action: "handled" };
    }
    if (query.length > 4_000) {
      if (ctx.hasUI) ctx.ui.notify("Search queries must be 4000 characters or fewer.", "error");
      return { action: "handled" };
    }

    try {
      const suggestions = await suggest(query);
      const exact = suggestions.find(({ name }) => name.toLowerCase() === query.toLowerCase());
      if (!exact) {
        if (ctx.hasUI) {
          ctx.ui.notify(suggestions.length ? "Choose a matching skill from the inline suggestions." : "No matching private skills found.", "warning");
        }
        return { action: "handled" };
      }
      if (exact.name.length > 200) {
        if (ctx.hasUI) ctx.ui.notify("Skill names must be 200 characters or fewer.", "error");
        return { action: "handled" };
      }
      return { action: "transform", text: skillReadPrompt(exact.name), images: event.images };
    } catch (error) {
      showFailure(error);
      return { action: "handled" };
    }
  });
}
