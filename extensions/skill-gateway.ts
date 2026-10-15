import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultRoots, search, searchRoots } from "../src/search.ts";
import { buildSkillGateRequest, type GateCandidate } from "../src/skill-gate.ts";
import { DEFAULT_USAGE_EVENTS, promptDigest } from "../src/usage-events.ts";
import { findLatestGateEvent, formatGateDetails, formatGateFooter } from "../src/pi-gate-telemetry.ts";
import { createFeedbackWidget, type FeedbackWidgetAction } from "../src/pi-feedback-widget.ts";
import { searchSkillUsageTurns, updateSkillUsageFeedback, type ShortlistRating } from "../src/skill-usage-feedback.ts";
import { parseSkillSelection, skillCompletions, skillReadPrompt } from "../src/picker-contract.ts";

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

type GateDebug = {
  prompt: string;
  promptSha256: string;
  candidates: GateCandidate[];
  event?: Record<string, unknown>;
  candidatesMatch?: boolean;
};

function gateCandidates(prompt: string): GateCandidate[] {
  const root = process.env.SKILL_GATEWAY_ROOT?.trim();
  const hits = root ? search(root, prompt, 5) : searchRoots(defaultRoots(), prompt, 5);
  return hits.slice(0, 5).map(({ name, description }) => ({ name, description }));
}

function readRecentUsageEvents(path: string, maxBytes = 1_000_000): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function currentGateEvent(sessionId: string, promptSha256: string): Record<string, unknown> | null {
  const path = process.env.SKILL_GATEWAY_EVENTS ?? DEFAULT_USAGE_EVENTS;
  if (!path || path === "-") return null;
  try {
    return findLatestGateEvent(readRecentUsageEvents(path), sessionId, promptSha256);
  } catch {
    return null;
  }
}

function recordedCandidateNames(event: Record<string, unknown>): string[] {
  return Array.isArray(event.candidate_names) ? event.candidate_names.filter((name): name is string => typeof name === "string") : [];
}

type FeedbackIdentity = { user_id: string | null; session_id: string; turn_id: string };

function feedbackIdentity(event: Record<string, unknown> | undefined): FeedbackIdentity | null {
  if (!event || typeof event.session_id !== "string" || !event.session_id.trim() || typeof event.turn_id !== "string" || !event.turn_id.trim()) return null;
  if (event.user_id !== undefined && event.user_id !== null && typeof event.user_id !== "string") return null;
  return {
    user_id: typeof event.user_id === "string" ? event.user_id : null,
    session_id: event.session_id,
    turn_id: event.turn_id,
  };
}

function currentFeedback(identity: FeedbackIdentity) {
  return searchSkillUsageTurns({ ...identity, limit: 1 }).results[0]?.feedback ?? null;
}

function showFeedbackWidget(ctx: ExtensionContext, debug: GateDebug): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const identity = feedbackIdentity(debug.event);
  if (!identity) {
    ctx.ui.setWidget("skill-gateway-feedback", undefined);
    return;
  }
  const feedback = currentFeedback(identity);
  ctx.ui.setWidget("skill-gateway-feedback", (_tui: unknown, _theme: unknown) => createFeedbackWidget(
    feedback?.shortlist_rating ?? null,
    feedback?.comment_present ?? false,
    (action) => {
      if (action === "note") {
        void promptFeedbackComment(ctx, identity, feedback?.comment_present ?? false, () => showFeedbackWidget(ctx, debug));
      } else {
        const rating: ShortlistRating = action;
        try {
          const result = updateSkillUsageFeedback({ ...identity, shortlist_rating: rating });
          ctx.ui.notify(result.status === "unchanged" ? "This search rating is already saved locally." : "Saved search rating locally.", "info");
          showFeedbackWidget(ctx, debug);
        } catch (error) {
          ctx.ui.notify(`Could not save search rating: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    },
  ), { placement: "belowEditor" });
}

async function promptFeedbackComment(
  ctx: ExtensionContext,
  identity: FeedbackIdentity,
  commentAlreadyPresent: boolean,
  refresh: () => void,
): Promise<void> {
  let comment: string | undefined;
  try {
    comment = await ctx.ui.input("Quick note for this skill search (stored locally)", "What was useful or irrelevant?");
  } catch (error) {
    ctx.ui.notify(`Could not open feedback note: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (comment === undefined || (!comment.trim() && !commentAlreadyPresent)) return;
  try {
    updateSkillUsageFeedback({
      ...identity,
      comment,
      ...(comment.trim() ? { comment_source: "user_verbatim" as const } : {}),
    });
    ctx.ui.notify(comment.trim() ? "Saved your note locally in the learning dataset." : "Cleared the saved note.", "info");
    refresh();
  } catch (error) {
    ctx.ui.notify(`Could not save search note: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function showSkillFeedbackCommand(pi: ExtensionAPI, getDebug: () => GateDebug | undefined): void {
  pi.registerCommand("skill-feedback", {
    description: "Rate the current skill search and optionally add a private note",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const debug = getDebug();
      const identity = feedbackIdentity(debug?.event);
      if (!debug || !identity) {
        ctx.ui.notify("No exactly linked skill search is available to rate for this turn.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Skill search feedback requires interactive Pi UI mode.", "warning");
        return;
      }
      const choice = await ctx.ui.select("Rate this skill search", ["Helpful", "Not useful", "Comment only"]);
      if (!choice) return;
      const rating: ShortlistRating | undefined = choice === "Helpful" ? "helpful" : choice === "Not useful" ? "not_helpful" : undefined;
      const oldFeedback = currentFeedback(identity);
      const comment = await ctx.ui.input("Optional note (stored locally)", "What was useful or irrelevant?");
      if (comment === undefined && !rating) return;
      if (comment !== undefined && !comment.trim() && !oldFeedback?.comment_present) {
        if (!rating) return;
      }
      try {
        updateSkillUsageFeedback({
          ...identity,
          ...(rating !== undefined ? { shortlist_rating: rating } : {}),
          ...(comment !== undefined && (comment.trim() || oldFeedback?.comment_present)
            ? { comment, ...(comment.trim() ? { comment_source: "user_verbatim" as const } : {}) }
            : {}),
        });
        ctx.ui.notify("Saved skill-search feedback locally in the learning dataset.", "info");
        if (debug) showFeedbackWidget(ctx, debug);
      } catch (error) {
        ctx.ui.notify(`Could not save skill-search feedback: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

function showGateDetails(pi: ExtensionAPI, getDebug: () => GateDebug | undefined): void {
  pi.registerCommand("skill-gate", {
    description: "Inspect this turn's skill-gate request and retrieval scores",
    handler: async (_args, ctx) => {
      const debug = getDebug();
      if (!debug?.event) {
        ctx.ui.notify("No matching skill-gate event for the current Pi turn.", "warning");
        return;
      }
      const event = debug.event;
      const body = debug.candidatesMatch && event.gate_status !== "no_candidates" && event.gate_status !== "bypassed"
        ? buildSkillGateRequest(debug.prompt, debug.candidates)
        : null;
      const details = formatGateDetails(event, body, Boolean(debug.candidatesMatch));
      if (!ctx.hasUI) {
        ctx.ui.notify("The skill-gate details view requires interactive Pi TUI mode.", "warning");
        return;
      }
      let tuiComponents;
      try {
        tuiComponents = await import("@earendil-works/pi-tui");
      } catch {
        ctx.ui.notify(details.slice(0, 3_000), "warning");
        return;
      }
      const { Key, Text, matchesKey } = tuiComponents;
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const content = new Text(details, 1, 1);
        let scrollTop = 0;
        let renderedLineCount = 0;
        const pageSize = 14;
        return {
          render(width: number): string[] {
            const lines = content.render(Math.max(10, width - 2));
            renderedLineCount = lines.length;
            scrollTop = Math.min(scrollTop, Math.max(0, renderedLineCount - pageSize));
            const end = Math.min(scrollTop + pageSize, renderedLineCount);
            return [
              theme.fg("accent", "Skill Gateway · ↑/↓ scroll · Esc/Enter close"),
              ...lines.slice(scrollTop, end),
              theme.fg("dim", `${scrollTop + 1}-${end} / ${renderedLineCount}`),
            ];
          },
          handleInput(data: string): void {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.q)) {
              done();
              return;
            }
            if (matchesKey(data, Key.up)) scrollTop = Math.max(0, scrollTop - 1);
            else if (matchesKey(data, Key.down)) scrollTop = Math.min(Math.max(0, renderedLineCount - pageSize), scrollTop + 1);
            else if (matchesKey(data, Key.pageUp)) scrollTop = Math.max(0, scrollTop - pageSize);
            else if (matchesKey(data, Key.pageDown)) scrollTop = Math.min(Math.max(0, renderedLineCount - pageSize), scrollTop + pageSize);
            else return;
            tui.requestRender();
          },
          invalidate(): void {
            content.invalidate();
          },
        };
      });
    },
  });
}

export function applyBackslashCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: { value: string },
  prefix: string,
) {
  const line = lines[cursorLine] ?? "";
  const prefixStart = cursorCol - prefix.length;
  const suffix = line.slice(cursorCol);
  const hasTrailingWhitespace = /^\s/.test(suffix);
  const insertion = `${item.value}${hasTrailingWhitespace ? "" : " "}`;
  const newLines = [...lines];
  newLines[cursorLine] = `${line.slice(0, prefixStart)}${insertion}${suffix}`;
  return {
    lines: newLines,
    cursorLine,
    cursorCol: prefixStart + insertion.length + (hasTrailingWhitespace ? 1 : 0),
  };
}

export default function (pi: ExtensionAPI): void {
  pi.registerMcpServer("skill_gateway", { url: endpoint, timeout: 5_000 });
  let gateDebug: GateDebug | undefined;
  showSkillFeedbackCommand(pi, () => gateDebug);

  pi.on("before_agent_start", (event: { prompt?: string }, ctx) => {
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("skill-gateway-feedback", undefined);
    if (!ctx.hasUI) return;
    const rawPrompt = typeof event.prompt === "string" ? event.prompt : "";
    if (!rawPrompt.trim()) {
      gateDebug = undefined;
      ctx.ui.setStatus("skill-gateway-gate", undefined);
      return;
    }
    ctx.ui.setStatus("skill-gateway-gate", "SG evaluating…");
    const prompt = rawPrompt.trim();
    try {
      gateDebug = { prompt, promptSha256: promptDigest(prompt), candidates: gateCandidates(rawPrompt) };
    } catch {
      gateDebug = { prompt, promptSha256: promptDigest(prompt), candidates: [] };
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI || !gateDebug) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      ctx.ui.setStatus("skill-gateway-gate", "SG gate event unavailable");
      return;
    }
    const event = currentGateEvent(sessionId, gateDebug.promptSha256);
    if (!event) {
      gateDebug = undefined;
      ctx.ui.setStatus("skill-gateway-gate", "SG gate event unavailable");
      return;
    }
    const localNames = gateDebug.candidates.map(({ name }) => name);
    const eventNames = recordedCandidateNames(event);
    gateDebug = { ...gateDebug, event, candidatesMatch: JSON.stringify(localNames) === JSON.stringify(eventNames) };
    ctx.ui.setStatus("skill-gateway-gate", formatGateFooter(event));
  });

  showGateDetails(pi, () => gateDebug);


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
      arguments: { query, limit: 20 },
    }, undefined, { signal, timeout: 5_000 });
    return parseSuggestions(result).results;
  };

  pi.on("turn_end", (_event, ctx) => {
    if (gateDebug?.event) showFeedbackWidget(ctx, gateDebug);
  });

  pi.on("session_start", (_event, ctx) => {
    failureShown = false;
    gateDebug = undefined;
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("skill-gateway-feedback", undefined);
    if (ctx.hasUI) ctx.ui.setStatus("skill-gateway-gate", undefined);
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
          return applyBackslashCompletion(lines, cursorLine, cursorCol, item, prefix);
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
    const selection = parseSkillSelection(text);
    if (!selection) return { action: "continue" };

    const { name: query, request } = selection;
    if (!query) {
      if (ctx.hasUI) ctx.ui.notify("Type after \\\\ and choose a skill suggestion.", "warning");
      return { action: "handled" };
    }
    if (text.length > 4_000) {
      if (ctx.hasUI) ctx.ui.notify("Skill picker input must be 4000 characters or fewer.", "error");
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
      return { action: "transform", text: skillReadPrompt(exact.name, request), images: event.images };
    } catch (error) {
      showFailure(error);
      return { action: "handled" };
    }
  });
}
